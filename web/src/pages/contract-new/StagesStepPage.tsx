import { useEffect, useMemo, useState } from 'react';
import { useQueries, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { ApiError, type RealChecklistItem, type RealContractMaterial, type RealMilestoneTreeNode } from '@porukam/core';
import { CurrencyField, StagesBuilder, type StageDraft, type StagesBuilderLabels, type StagesBuilderValue } from '@porukam/ui';
import {
  useCreateRealChecklistItem,
  useCreateRealMaterial,
  useCreateRealMilestone,
  useDeleteRealChecklistItem,
  useDeleteRealMaterial,
  useDeleteRealMilestone,
  usePatchRealMilestone,
  useRealContractMilestones,
  useUpdateRealChecklistItem,
  useUpdateRealMaterial,
  refetchRealMilestones,
} from '../../features/contracts/realApi';
import {
  buildMaterialsModalLabels,
  isServerMaterialId,
  materialChanged,
  resolveMaterialCatalog,
  serverMaterialId,
  toDraftMaterial,
  toMaterialInput,
} from '../../features/contracts/materials';
import { api } from '../../shared/api';
import { useChecklistRecommendations, useMaterialCatalog, useUnits } from '../../features/contractNew/api';
import { useContractNewStore } from '../../features/contractNew/draftStore';
import { WIZARD_CURRENCIES, suggestedCurrencyForLocale } from '../../features/contractNew/currencies';
import { WizardFooter } from './WizardFooter';
import wizardStyles from './ContractNewPage.module.css';

/** Локальный (ещё не созданный на сервере) этап — id от конструктора, не uuid бэка. */
const isLocalId = (id: string): boolean => id.startsWith('stage-');

/** Пункт чек-листа, уже созданный на сервере, — в конструкторе живёт под
 * `srv-<uuid>` (см. `fromServer`); новые пункты получают id конструктора
 * (`cl-…`) и по «Далее» уходят в POST. */
const SERVER_ITEM_PREFIX = 'srv-';
const isServerItemId = (id: string): boolean => id.startsWith(SERVER_ITEM_PREFIX);
const serverItemId = (id: string): string => id.slice(SERVER_ITEM_PREFIX.length);

function flattenLeaves(nodes: RealMilestoneTreeNode[]): RealMilestoneTreeNode[] {
  return nodes.flatMap((n) => (n.is_leaf ? [n] : flattenLeaves(n.children)));
}

/** Плоский список листьев ← реальное дерево (`GET /contracts/{id}/milestones`).
 * Чек-листы созданных этапов в дереве не приходят — догружаются отдельно
 * (`GET /milestones/{id}/checklist-items`): копия этапа (отсмотр 2026-08-20)
 * переносит критерии, а сами критерии редактируются и после сохранения
 * этапа (отсмотр 2026-08-25 — раньше редактор прятался, и второй критерий
 * не сохранялся): по «Далее» список сверяется с серверным — новые → POST,
 * убранные → DELETE, изменённые → PATCH (`/checklist-items/{id}`). */
function fromServer(
  nodes: RealMilestoneTreeNode[],
  checklists: Map<string, RealChecklistItem[]>,
  materials: Map<string, RealContractMaterial[]>,
): StageDraft[] {
  return flattenLeaves(nodes).map((m) => ({
    id: m.id,
    sectionId: null,
    title: m.title,
    amount: m.amount ?? '',
    auto: false,
    durationDays: '',
    checklist: (checklists.get(m.id) ?? []).map((c) => ({
      id: `srv-${c.id}`,
      text: c.description,
      requiredEvidence: c.required_evidence.length > 0,
    })),
    materials: (materials.get(m.id) ?? []).map(toDraftMaterial),
    advance: null,
    advancePercent: null,
  }));
}

/** Строит `labels` для StagesBuilder (вложенные StageEditor/ChecklistEditor и модалки;
 * аванс скрыт features-флагом, его labels остаются для типа). */
function buildStagesBuilderLabels(t: TFunction): StagesBuilderLabels {
  return {
    totalCostLabel: t('contractNew.stagesBuilder.totalCostLabel'),
    totalCostHint: t('contractNew.stagesBuilder.totalCostHint'),
    totalCostPlaceholder: t('contractNew.stagesBuilder.totalCostPlaceholder'),
    totalCostHelp: t('hints.stage.totalCost'),
    helpLabel: t('hints.helpButton'),
    addStage: t('contractNew.stagesBuilder.addStage'),
    addSection: t('contractNew.stagesBuilder.addSection'),
    newSectionTitle: t('contractNew.stagesBuilder.newSectionTitle'),
    formatDeleteSectionConfirm: (count) => t('contractNew.stagesBuilder.deleteSectionConfirm', { count }),
    deleteStageConfirm: t('contractNew.stagesBuilder.deleteStageConfirm'),
    deleteStageAria: t('contractNew.stagesBuilder.deleteStageAria'),
    copyStageAria: t('contractNew.stagesBuilder.copyStageAria'),
    saveStage: t('contractNew.stagesBuilder.saveStage'),
    deleteSectionAria: t('contractNew.stagesBuilder.deleteSectionAria'),
    autoLabel: t('contractNew.stagesBuilder.autoLabel'),
    emptyAmountHint: t('contractNew.stagesBuilder.emptyAmountHint'),
    totalRowLabel: t('contractNew.stagesBuilder.totalRowLabel'),
    match: t('contractNew.stagesBuilder.match'),
    formatMismatch: (diff, currency) => t('contractNew.stagesBuilder.mismatch', { diff, currency }),
    formatDurationNote: (days) => t('contractNew.stagesBuilder.durationNote', { days }),
    formatDuration: (days) => t('contractNew.stagesBuilder.durationSuffix', { days }),
    untitledStage: t('contractNew.stagesBuilder.newStageTitle'),
    newStageTitle: t('contractNew.stagesBuilder.newStageTitle'),
    stageSheetTitle: t('contractNew.stagesBuilder.genericStageName'),
    closeLabel: t('common.close'),
    stageEditor: {
      titleLabel: t('contractNew.stageEditor.titleLabel'),
      titlePlaceholder: t('contractNew.stageEditor.titlePlaceholder'),
      amountLabel: t('contractNew.stageEditor.amountLabel'),
      amountHint: t('contractNew.stageEditor.amountHint'),
      amountPlaceholder: t('contractNew.stageEditor.amountPlaceholder'),
      durationLabel: t('contractNew.stageEditor.durationLabel'),
      durationPlaceholder: t('contractNew.stageEditor.durationPlaceholder'),
      checklistSectionTitle: t('contractNew.stageEditor.checklistSectionTitle'),
      titleHelp: t('hints.stage.title'),
      amountHelp: t('hints.stage.amount'),
      durationHelp: t('hints.stage.duration'),
      checklistHelp: t('hints.stage.checklist'),
      helpLabel: t('hints.helpButton'),
      materialsBtn: t('contractNew.stageEditor.materialsBtn'),
      paymentBtn: t('contractNew.stageEditor.paymentBtn'),
      formatAdvanceBtn: (amount) => t('contractNew.stageEditor.advanceBtn', { amount }),
      checklist: {
        addPlaceholder: t('contractNew.checklist.addPlaceholder'),
        addLabel: t('contractNew.checklist.addLabel'),
        requiredLabel: t('contractNew.checklist.requiredLabel'),
        emptyWarning: t('contractNew.checklist.emptyWarning'),
        deleteAria: t('contractNew.checklist.deleteAria'),
        suggestionsTitle: t('contractNew.checklist.suggestionsTitle'),
        suggestionAddAria: t('contractNew.checklist.suggestionAddAria'),
        formatShowAll: (count) => t('contractNew.checklist.showAll', { count }),
        showLess: t('contractNew.checklist.showLess'),
        noMatchHint: t('contractNew.checklist.noMatchHint'),
        addHelp: t('hints.stage.evidence'),
        helpLabel: t('hints.helpButton'),
      },
    },
    materialsModal: buildMaterialsModalLabels(t),
    paymentModal: {
      title: t('contractNew.paymentModal.title'),
      cancel: t('contractNew.paymentModal.cancel'),
      done: t('contractNew.paymentModal.done'),
      amountRowLabel: t('contractNew.paymentModal.amountRowLabel'),
      advanceLabel: t('contractNew.paymentModal.advanceLabel'),
      advancePlaceholder: t('contractNew.paymentModal.advancePlaceholder'),
      advancePercentLabel: t('contractNew.paymentModal.advancePercentLabel'),
      advancePercentPlaceholder: t('contractNew.paymentModal.advancePercentPlaceholder'),
      postLabel: t('contractNew.paymentModal.postLabel'),
      disclaimer: t('contractNew.paymentModal.disclaimer'),
      closeLabel: t('common.close'),
    },
  };
}

/**
 * Шаг «Этапы» (ADR-088 Фаза 2) — конструктор поверх РЕАЛЬНОГО плоского API:
 * `POST /contracts/{id}/milestones` на каждый новый лист (+ его пункты чек-листа
 * `POST /milestones/{id}/checklist-items`), `PATCH /milestones/{id}` на правку
 * названия/суммы, `DELETE /milestones/{id}` (ADR-101) на каждый убранный из
 * списка созданный этап; чек-лист уже созданного этапа — diff с серверным
 * списком (`POST`/`PATCH`/`DELETE` пункта, число пунктов не ограничено).
 * Материалы этапа (решение владельца 03.09 — «верни в мастер на шаг Этапы,
 * она не должна исчезать») сверяются ТЕМ ЖЕ способом:
 * `POST /milestones/{id}/materials` на новые, `PATCH`/`DELETE /materials/{id}`
 * на изменённые и убранные. Разделы (ветки), аванс и длительность скрыты —
 * их нет у реального Milestone. Все изменения уезжают на сервер по «Далее»
 * (одна точка сохранения шага, как и раньше); до «Далее» дерево автосейвится
 * в draftStore (StagesDraft) — переживает уход на соседний шаг и F5.
 */
export function StagesStepPage(): JSX.Element {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const draftId = useContractNewStore((s) => s.draftId);
  const storedCurrency = useContractNewStore((s) => s.currency);
  // Автоподстановка валюты по языку интерфейса (отсмотр 2026-08-19) —
  // человек видит конкретное значение и может сменить его в списке.
  const currency = storedCurrency || suggestedCurrencyForLocale(i18n.language);
  const setCurrency = useContractNewStore((s) => s.setCurrency);
  const sphereCode = useContractNewStore((s) => s.sphereCode);
  const workType = useContractNewStore((s) => s.workType);
  const setSaving = useContractNewStore((s) => s.setSaving);
  const setErrorStepPath = useContractNewStore((s) => s.setErrorStepPath);
  const savedStages = useContractNewStore((s) => s.stages);
  const setStages = useContractNewStore((s) => s.setStages);

  const { data: milestones } = useRealContractMilestones(draftId ?? undefined);
  const { data: catalog } = useMaterialCatalog(sphereCode);
  const { data: units } = useUnits();
  // Одна позиция «Прочее» (`other_<sphere>`) вместо десятка одинаковых по всем сферам.
  const { items: materialCatalog, otherRef: materialOtherRef } = useMemo(
    () => resolveMaterialCatalog(catalog ?? [], sphereCode),
    [catalog, sphereCode],
  );
  // ADR-091 §1 — реальный бэк требует sphere в паре с workType; без выбранного
  // вида работ рекомендаций нет (hook отключён).
  const { data: suggestions } = useChecklistRecommendations(sphereCode, workType);

  const createMilestone = useCreateRealMilestone(draftId ?? undefined);
  const patchMilestone = usePatchRealMilestone(draftId ?? undefined);
  const deleteMilestone = useDeleteRealMilestone(draftId ?? undefined);
  const createChecklistItem = useCreateRealChecklistItem(draftId ?? undefined);
  const updateChecklistItem = useUpdateRealChecklistItem(draftId ?? undefined);
  const deleteChecklistItem = useDeleteRealChecklistItem(draftId ?? undefined);
  const createMaterial = useCreateRealMaterial(draftId ?? undefined);
  const updateMaterial = useUpdateRealMaterial(draftId ?? undefined);
  const deleteMaterial = useDeleteRealMaterial(draftId ?? undefined);

  const serverLeafIds = useMemo(() => flattenLeaves(milestones ?? []).map((m) => m.id), [milestones]);
  const checklistQueries = useQueries({
    queries: serverLeafIds.map((id) => ({
      queryKey: ['real-checklist-items', id],
      queryFn: () => api.request<RealChecklistItem[]>(`/milestones/${id}/checklist-items`, { actor: true }),
    })),
  });
  const checklistsLoaded = checklistQueries.every((q) => q.data !== undefined || q.isError);
  /** Серверные чек-листы по id этапа — эталон для diff в `next()`. */
  const serverChecklists = useMemo(() => {
    const map = new Map<string, RealChecklistItem[]>();
    serverLeafIds.forEach((id, i) => {
      const data = checklistQueries[i]?.data;
      if (data) map.set(id, data);
    });
    return map;
  }, [serverLeafIds, checklistQueries]);

  // Материалы созданных этапов, как и чек-листы, в дереве не приходят —
  // догружаются отдельно (`GET /milestones/{id}/materials`) и по «Далее»
  // сверяются с локальным списком.
  const materialQueries = useQueries({
    queries: serverLeafIds.map((id) => ({
      queryKey: ['real-materials', id],
      queryFn: () => api.request<RealContractMaterial[]>(`/milestones/${id}/materials`, { actor: true }),
    })),
  });
  const materialsLoaded = materialQueries.every((q) => q.data !== undefined || q.isError);
  /** Серверные материалы по id этапа — эталон для diff в `next()`. */
  const serverMaterials = useMemo(() => {
    const map = new Map<string, RealContractMaterial[]>();
    serverLeafIds.forEach((id, i) => {
      const data = materialQueries[i]?.data;
      if (data) map.set(id, data);
    });
    return map;
  }, [serverLeafIds, materialQueries]);

  const [totalCost, setTotalCost] = useState('');
  const [local, setLocal] = useState<StageDraft[] | null>(null);
  const [serverError, setServerError] = useState<string | null>(null);

  // Автосейв шага (замечание владельца 02.09: «на этапе случайно нажал не ту
  // кнопку — отбрасывает на суть, а там много введено»): дерево конструктора
  // до «Далее» живёт в draftStore (persist) и при возврате/после F5 главнее
  // серверного — то отстаёт на всё, что человек ввёл после последнего «Далее».
  // Снимок чужого черновика игнорируется.
  const saved = savedStages && savedStages.draftId === draftId ? savedStages : null;

  useEffect(() => {
    if (!milestones || local || !checklistsLoaded || !materialsLoaded) return;
    if (saved) {
      // Этапы с серверным id, которых на сервере уже нет, отбрасываем —
      // PATCH по ним всё равно упал бы; локальные (ещё не созданные) берём как есть.
      const serverIds = new Set(flattenLeaves(milestones).map((m) => m.id));
      setLocal(saved.stages.filter((s) => isLocalId(s.id) || serverIds.has(s.id)));
      setTotalCost(saved.totalCost);
      return;
    }
    setLocal(fromServer(milestones, serverChecklists, serverMaterials));
  }, [milestones, local, checklistsLoaded, materialsLoaded, serverChecklists, serverMaterials, saved]);

  // Снимок обновляется на каждое изменение конструктора (он коммитит ввод
  // сразу — StagesBuilder.patchStage); persist доводит до localStorage сам.
  useEffect(() => {
    if (!local || !draftId) return;
    setStages({ draftId, stages: local, totalCost });
  }, [local, totalCost, draftId, setStages]);

  const value: StagesBuilderValue = { sections: [], stages: local ?? [], totalCost };

  /** Чек-лист УЖЕ созданного этапа: сверка локального списка с серверным
   * (число пунктов НЕ ограничено — отсмотр 2026-08-25). Сначала DELETE
   * убранных, затем по порядку: новые (id конструктора) → POST, оставшиеся
   * серверные → PATCH, если поменялся текст, признак «нужно доказательство»
   * или `order` (перенумерация после удаления/вставки в середину). */
  async function syncChecklist(milestoneId: string, items: StageDraft['checklist']): Promise<void> {
    const serverItems = serverChecklists.get(milestoneId) ?? [];
    const keptIds = new Set(items.filter((c) => isServerItemId(c.id)).map((c) => serverItemId(c.id)));
    for (const it of serverItems) {
      if (!keptIds.has(it.id)) await deleteChecklistItem.mutateAsync(it.id);
    }
    for (const [j, c] of items.entries()) {
      if (!isServerItemId(c.id)) {
        await createChecklistItem.mutateAsync({
          milestoneId,
          input: {
            description: c.text,
            measurable_criterion: c.text,
            required_evidence: c.requiredEvidence ? ['photo'] : [],
            order: j,
          },
        });
        continue;
      }
      const server = serverItems.find((it) => it.id === serverItemId(c.id));
      if (!server) continue;
      const textChanged = server.description !== c.text;
      const evidenceChanged = (server.required_evidence.length > 0) !== c.requiredEvidence;
      const orderChanged = server.order !== j;
      if (!textChanged && !evidenceChanged && !orderChanged) continue;
      await updateChecklistItem.mutateAsync({
        itemId: server.id,
        input: {
          ...(textChanged ? { description: c.text, measurable_criterion: c.text } : {}),
          ...(evidenceChanged ? { required_evidence: c.requiredEvidence ? ['photo'] : [] } : {}),
          ...(orderChanged ? { order: j } : {}),
        },
      });
    }
  }

  /** Материалы УЖЕ созданного этапа — та же сверка, что у чек-листа:
   * убранные → DELETE, новые (id конструктора) → POST, изменённые серверные →
   * PATCH. Порядка у материалов нет (в отличие от пунктов чек-листа), поэтому
   * перенумерации тут нет. */
  async function syncMaterials(milestoneId: string, items: StageDraft['materials']): Promise<void> {
    const serverItems = serverMaterials.get(milestoneId) ?? [];
    const keptIds = new Set(items.filter((m) => isServerMaterialId(m.id)).map((m) => serverMaterialId(m.id)));
    for (const m of serverItems) {
      if (!keptIds.has(m.id)) await deleteMaterial.mutateAsync(m.id);
    }
    for (const item of items) {
      if (!isServerMaterialId(item.id)) {
        await createMaterial.mutateAsync({ milestoneId, input: toMaterialInput(item, currency) });
        continue;
      }
      const server = serverItems.find((m) => m.id === serverMaterialId(item.id));
      if (!server || !materialChanged(server, item, currency)) continue;
      await updateMaterial.mutateAsync({ materialId: server.id, input: toMaterialInput(item, currency) });
    }
  }

  async function next(): Promise<void> {
    if (!draftId || !local) return;
    setSaving(true);
    setServerError(null);
    setErrorStepPath(null);
    const serverLeaves = flattenLeaves(milestones ?? []);
    try {
      // Убранные из списка созданные этапы — DELETE (ADR-101); сначала, чтобы
      // порядок (order) оставшихся считался по уже очищенному дереву.
      const keptIds = new Set(local.map((s) => s.id));
      for (const m of serverLeaves) {
        if (!keptIds.has(m.id)) await deleteMilestone.mutateAsync(m.id);
      }
      for (const [i, s] of local.entries()) {
        const title = s.title.trim() || t('contractNew.stagesBuilder.newStageTitle');
        const amountInput = s.amount ? { amount: s.amount, currency } : {};
        if (isLocalId(s.id)) {
          const created = (await createMilestone.mutateAsync({
            title,
            order: i,
            sphere_code: sphereCode || undefined,
            ...amountInput,
          })) as { id: string };
          for (const [j, c] of s.checklist.entries()) {
            await createChecklistItem.mutateAsync({
              milestoneId: created.id,
              input: {
                description: c.text,
                measurable_criterion: c.text,
                required_evidence: c.requiredEvidence ? ['photo'] : [],
                order: j,
              },
            });
          }
          for (const m of s.materials) {
            await createMaterial.mutateAsync({ milestoneId: created.id, input: toMaterialInput(m, currency) });
          }
        } else {
          const server = serverLeaves.find((m) => m.id === s.id);
          const changed = server && (server.title !== title || (server.amount ?? '') !== s.amount || server.order !== i);
          if (changed) {
            await patchMilestone.mutateAsync({ milestoneId: s.id, input: { title, order: i, ...amountInput } });
          }
          await syncChecklist(s.id, s.checklist);
          await syncMaterials(s.id, s.materials);
        }
      }
      // Дерево доехало до сервера — снимок больше не нужен; локальное состояние
      // не трогаем: страница размонтируется переходом (иначе засев из ещё
      // старого кэша пересоздал бы снимок).
      setStages(null);
      navigate('../terms');
    } catch (e) {
      setErrorStepPath('stages');
      setServerError(e instanceof ApiError ? e.message : String(e));
      // Часть этапов могла создаться — пересобрать из СВЕЖЕГО серверного дерева,
      // не дублировать; снимок тоже снимаем, иначе он вернул бы локальные копии
      // уже созданных.
      setStages(null);
      await refetchRealMilestones(qc, draftId);
      setLocal(null);
    } finally {
      setSaving(false);
    }
  }

  if (!local || !catalog || !units) return <p>{t('common.loading')}</p>;

  return (
    <>
      <h2 className={wizardStyles.stepTitle}>{t('contractNew.stagesTitle')}</h2>
      <p className={wizardStyles.stepSub}>{t('contractNew.stagesSub')}</p>

      <CurrencyField
        label={t('contractNew.currencyLabel')}
        help={t('hints.contractNew.currency')}
        helpLabel={t('hints.helpButton')}
        value={currency}
        options={[...WIZARD_CURRENCIES]}
        onChange={setCurrency}
      />

      <StagesBuilder
        value={value}
        onChange={(v) => {
          setLocal(v.stages);
          setTotalCost(v.totalCost);
        }}
        currency={currency}
        catalog={materialCatalog}
        units={units}
        materialOtherRef={materialOtherRef}
        checklistSuggestions={suggestions}
        labels={buildStagesBuilderLabels(t)}
        features={{ sections: false, materials: true, payment: false, duration: false }}
      />

      {serverError ? (
        <p role="alert" className={wizardStyles.stepError} data-testid="stages-error">
          {serverError}
        </p>
      ) : null}

      <WizardFooter
        onBack={() => navigate('../details')}
        onNext={next}
        nextLoading={
          createMilestone.isPending ||
          patchMilestone.isPending ||
          deleteMilestone.isPending ||
          createChecklistItem.isPending ||
          updateChecklistItem.isPending ||
          deleteChecklistItem.isPending ||
          createMaterial.isPending ||
          updateMaterial.isPending ||
          deleteMaterial.isPending
        }
      />
    </>
  );
}
