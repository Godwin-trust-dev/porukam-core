import { useState } from 'react';
import { distributeEvenly, sumMoney, type MaterialCatalogItem, type MoneyLike, type UnitOption } from '@porukam/core';
import { Badge } from './Badge';
import { Button } from './Button';
import { Icon } from './Icon';
import { TextField } from './Field';
import type { ChecklistDraftItem } from './ChecklistEditor';
import { MaterialsModal, type MaterialsModalDraftItem, type MaterialsModalLabels } from './MaterialsModal';
import { PaymentModal, type PaymentModalLabels } from './PaymentModal';
import { Sheet } from './Sheet';
import { SectionHeader } from './SectionHeader';
import { StageEditor, type StageEditorLabels } from './StageEditor';
import { StageRow } from './StageRow';
import styles from './StagesBuilder.module.css';

export interface SectionDraft {
  id: string;
  title: string;
}

export interface StageDraft {
  id: string;
  sectionId: string | null;
  title: string;
  /** '' — сумма ещё не задана (пустая «стоимость работ» или ручное поле пусто). */
  amount: string;
  /** Участвует в авто-разносе «стоимости работ» поровну; снимается ручной правкой суммы. */
  auto: boolean;
  durationDays: string;
  checklist: ChecklistDraftItem[];
  materials: MaterialsModalDraftItem[];
  advance: MoneyLike | null;
  advancePercent: number | null;
}

export interface StagesBuilderValue {
  sections: SectionDraft[];
  stages: StageDraft[];
  /** «Стоимость работ» (опц.) — сверху, разносится поровну по этапам-«авто». */
  totalCost: string;
}

export interface StagesBuilderLabels {
  totalCostLabel: string;
  totalCostHint: string;
  totalCostPlaceholder: string;
  /** Подсказка «?» у «стоимости работ» (отсмотр 22.08 — подсказки по полям всех форм). */
  totalCostHelp?: string;
  /** Доступное имя кнопки «?» — общее на все подсказки конструктора. */
  helpLabel?: string;
  addStage: string;
  addSection: string;
  newSectionTitle: string;
  /** Шаблон с `{{count}}` — вызывающий сам подставляет (i18next-интерполяция). */
  formatDeleteSectionConfirm: (count: number) => string;
  deleteStageConfirm: string;
  deleteStageAria: string;
  /** Копирование этапа (отсмотр 2026-08-20). */
  copyStageAria?: string;
  /** Кнопка «Сохранить» в окне этапа — закрывает окно (правки применяются
   * по ходу ввода; кнопка нужна, чтобы было понятно, что делать дальше). */
  saveStage?: string;
  deleteSectionAria: string;
  autoLabel: string;
  emptyAmountHint: string;
  totalRowLabel: string;
  match: string;
  /** Шаблоны с `{{diff}}`/`{{currency}}`/`{{days}}` — вызывающий сам подставляет. */
  formatMismatch: (diff: string, currency: string) => string;
  formatDurationNote: (days: number) => string;
  formatDuration: (days: string) => string;
  untitledStage: string;
  newStageTitle: string;
  stageSheetTitle: string;
  closeLabel: string;
  stageEditor: StageEditorLabels;
  materialsModal: MaterialsModalLabels;
  paymentModal: PaymentModalLabels;
}

export interface StagesBuilderProps {
  value: StagesBuilderValue;
  onChange: (value: StagesBuilderValue) => void;
  currency: string;
  catalog: MaterialCatalogItem[];
  units: UnitOption[];
  /** Рекомендации чек-листа по типу работ (§4.2) — предзаполняют новый этап. */
  checklistSuggestions?: string[];
  /** Код позиции каталога материалов, означающей «Прочее» (свободное название):
   * на реальном каталоге это `other_<sphere>`, вызывающий резолвит его по сфере. */
  materialOtherRef?: string;
  /** Все текстовые строки — от вызывающего (i18n, глобальная версия — 6 языков). */
  labels: StagesBuilderLabels;
  /** ADR-088 Фаза 2: реальный Milestone не имеет длительности/материалов/аванса,
   * а разделы (ветки) в мастере v1 не создаются — флаги скрывают лишнее
   * («не показываем то, чего нет»). По умолчанию всё включено (мок-совместимость). */
  features?: { sections?: boolean; materials?: boolean; payment?: boolean; duration?: boolean };
  /** false — этап уже создан на сервере (DELETE /milestones нет), кнопка удаления скрыта. */
  isStageDeletable?: (stage: StageDraft) => boolean;
  /** false — чек-лист этапа в мастере не правится (см. StageEditor.showChecklist). */
  isStageChecklistEditable?: (stage: StageDraft) => boolean;
}

let seq = 0;
const nid = (p: string) => `${p}-${Date.now()}-${seq++}`;

/** «1 200,50» → «1200.50»: десятичная запятая и пробелы-разделители из
 * русской раскладки иначе давали NaN в итоге («сумма внизу не пересчитывается»,
 * отсмотр 2026-08-20). Сама строка ввода остаётся как есть — нормализуется
 * только значение, уходящее в расчёт/на сервер. */
export function normalizeAmountInput(raw: string): string {
  return raw.replace(/\s/g, '').replace(',', '.');
}

/** Новый этап — чек-лист ПУСТОЙ: рекомендации не предзаполняются, а
 * предлагаются кликабельным списком в ChecklistEditor (отсмотр 2026-08-19:
 * предзаполнение читалось как «выбирать нельзя, только удалять крестиком»). */
function newStage(sectionId: string | null): StageDraft {
  return {
    id: nid('stage'),
    sectionId,
    title: '',
    amount: '',
    auto: true,
    durationDays: '',
    checklist: [],
    materials: [],
    advance: null,
    advancePercent: null,
  };
}

/** Пересчитывает суммы «авто»-этапов: (totalCost − Σ ручных) / n авто, остаток — в последний. */
function recomputeAuto(stages: StageDraft[], totalCost: string, currency: string): StageDraft[] {
  const total = totalCost.trim() === '' ? NaN : Number(totalCost);
  const autoStages = stages.filter((s) => s.auto);
  if (Number.isNaN(total)) {
    return stages.map((s) => (s.auto ? { ...s, amount: '' } : s));
  }
  const manualSum = stages.filter((s) => !s.auto).reduce((sum, s) => sum + Number(s.amount || 0), 0);
  const remaining = Math.max(0, total - manualSum);
  const parts = distributeEvenly({ amount: remaining.toFixed(2), currency }, autoStages.length);
  let i = 0;
  return stages.map((s) => {
    if (!s.auto) return s;
    const part = parts[i];
    i += 1;
    return { ...s, amount: part ? part.amount : '0.00' };
  });
}

/**
 * ⭐ Конструктор этапов (DEV-09 §4) — разделы группируют, этапы принимаются/оплачиваются
 * (внутр. `branch`/`leaf`). Живой итог и срок; «стоимость работ» разносится поровну,
 * ручная правка снимает «поровну» с этого этапа и перераспределяет остаток между другими.
 */
export function StagesBuilder({
  value,
  onChange,
  currency,
  catalog,
  units,
  checklistSuggestions = [],
  materialOtherRef,
  labels: l,
  features,
  isStageDeletable,
  isStageChecklistEditable,
}: StagesBuilderProps): JSX.Element {
  const showSections = features?.sections ?? true;
  const showMaterials = features?.materials ?? true;
  const showPayment = features?.payment ?? true;
  const showDuration = features?.duration ?? true;
  const { sections, stages, totalCost } = value;
  const [selectedStageId, setSelectedStageId] = useState<string | null>(null);
  const [materialsStageId, setMaterialsStageId] = useState<string | null>(null);
  const [paymentStageId, setPaymentStageId] = useState<string | null>(null);

  function commit(nextStages: StageDraft[], nextSections = sections, nextTotalCost = totalCost): void {
    onChange({ sections: nextSections, stages: nextStages, totalCost: nextTotalCost });
  }

  function handleTotalCostChange(v: string): void {
    const value = normalizeAmountInput(v);
    commit(recomputeAuto(stages, value, currency), sections, value);
  }

  function addSection(): void {
    commit(stages, [...sections, { id: nid('section'), title: l.newSectionTitle }]);
  }

  function removeSection(id: string): void {
    const child = stages.filter((s) => s.sectionId === id);
    if (child.length > 0 && !window.confirm(l.formatDeleteSectionConfirm(child.length))) return;
    const remaining = stages.filter((s) => s.sectionId !== id);
    commit(recomputeAuto(remaining, totalCost, currency), sections.filter((s) => s.id !== id));
  }

  function addStage(sectionId: string | null): void {
    commit(recomputeAuto([...stages, newStage(sectionId)], totalCost, currency));
  }

  function removeStage(id: string): void {
    const s = stages.find((x) => x.id === id);
    if (s && (s.checklist.length > 0 || s.materials.length > 0) && !window.confirm(l.deleteStageConfirm)) return;
    if (selectedStageId === id) setSelectedStageId(null);
    commit(recomputeAuto(stages.filter((x) => x.id !== id), totalCost, currency));
  }

  function patchStage(id: string, patch: Partial<StageDraft>): void {
    commit(stages.map((s) => (s.id === id ? { ...s, ...patch } : s)));
  }

  function editAmount(id: string, rawAmount: string): void {
    const amount = normalizeAmountInput(rawAmount);
    // Ручная правка снимает «поровну» с ЭТОГО этапа; остальные авто-этапы пересчитываются.
    const next = stages.map((s) => (s.id === id ? { ...s, amount, auto: false } : s));
    commit(recomputeAuto(next, totalCost, currency));
  }

  /** Копия этапа сразу под оригиналом: название, сумма (ручная — «поровну»
   * снимается, чтобы копия не перераспределила остальные), чек-лист и
   * материалы с новыми id. */
  function duplicateStage(id: string): void {
    const index = stages.findIndex((s) => s.id === id);
    const source = stages[index];
    if (!source) return;
    const copy: StageDraft = {
      ...source,
      id: nid('stage'),
      auto: source.amount === '' ? source.auto : false,
      checklist: source.checklist.map((c) => ({ ...c, id: nid('cl') })),
      materials: source.materials.map((m) => ({ ...m, id: nid('mat') })),
    };
    const next = [...stages.slice(0, index + 1), copy, ...stages.slice(index + 1)];
    commit(recomputeAuto(next, totalCost, currency));
  }

  const stagesWithAmount = stages.filter((s) => s.amount !== '' && !Number.isNaN(Number(s.amount)));
  const sum = sumMoney(
    stagesWithAmount.map((s) => ({ amount: s.amount, currency })),
    currency,
  );
  const totalDays = stages.reduce((d, s) => d + (Number(s.durationDays) || 0), 0);
  const totalNumber = totalCost.trim() === '' ? null : Number(totalCost);
  const matches = totalNumber === null || Number.isNaN(totalNumber) ? null : Math.abs(totalNumber - Number(sum.amount)) < 0.005;

  const selectedStage = stages.find((s) => s.id === selectedStageId) ?? null;
  const materialsStage = stages.find((s) => s.id === materialsStageId) ?? null;
  const paymentStage = stages.find((s) => s.id === paymentStageId) ?? null;

  const rootStages = stages.filter((s) => s.sectionId === null);

  function renderStageRow(s: StageDraft): JSX.Element {
    return (
      <StageRow
        key={s.id}
        title={s.title}
        amount={s.amount ? { amount: s.amount, currency } : null}
        auto={s.auto}
        durationDays={s.durationDays || undefined}
        onOpen={() => setSelectedStageId(s.id)}
        onDelete={isStageDeletable && !isStageDeletable(s) ? undefined : () => removeStage(s.id)}
        onCopy={() => duplicateStage(s.id)}
        emptyAmountHint={l.emptyAmountHint}
        autoLabel={l.autoLabel}
        deleteAria={l.deleteStageAria}
        copyAria={l.copyStageAria}
        untitledLabel={l.newStageTitle}
        formatDuration={l.formatDuration}
      />
    );
  }

  return (
    <div className={styles.wrap} data-testid="stages-builder">
      <TextField
        label={l.totalCostLabel}
        hint={l.totalCostHint}
        help={l.totalCostHelp}
        helpLabel={l.helpLabel}
        placeholder={l.totalCostPlaceholder}
        inputMode="decimal"
        value={totalCost}
        onChange={(e) => handleTotalCostChange(e.target.value)}
        data-testid="total-cost"
      />

      <div className={styles.list}>
        {sections.map((sec) => (
          <div className={styles.section} key={sec.id}>
            <SectionHeader
              title={sec.title}
              amount={sumMoney(
                stages.filter((s) => s.sectionId === sec.id && s.amount !== '').map((s) => ({ amount: s.amount, currency })),
                currency,
              )}
              onDelete={() => removeSection(sec.id)}
              deleteAria={l.deleteSectionAria}
            />
            <div className={styles.sectionStages}>
              {stages.filter((s) => s.sectionId === sec.id).map(renderStageRow)}
              <button type="button" className={styles.addStageBtn} onClick={() => addStage(sec.id)} data-testid={`add-stage-in-${sec.id}`}>
                <Icon name="plus" size={16} /> {l.addStage}
              </button>
            </div>
          </div>
        ))}

        {rootStages.map(renderStageRow)}

        <div className={styles.addRow}>
          <Button variant="ghost" onClick={() => addStage(null)} data-testid="add-stage">
            <Icon name="plus" size={16} /> {l.addStage}
          </Button>
          {showSections ? (
            <Button variant="ghost" onClick={addSection} data-testid="add-section">
              <Icon name="plus" size={16} /> {l.addSection}
            </Button>
          ) : null}
        </div>
      </div>

      <div className={styles.summary}>
        <div className={styles.summaryRow}>
          <span>{l.totalRowLabel}</span>
          <strong data-testid="stages-sum">{sum.amount} {currency}</strong>
        </div>
        {matches !== null ? (
          <span data-testid="sum-match-badge">
            <Badge tone={matches ? 'green' : 'red'} dot>
              {matches ? l.match : l.formatMismatch(Math.abs((totalNumber ?? 0) - Number(sum.amount)).toFixed(2), currency)}
            </Badge>
          </span>
        ) : null}
        {showDuration ? (
          <p className={styles.durationNote} data-testid="stages-duration">
            {l.formatDurationNote(totalDays)}
          </p>
        ) : null}
      </div>

      <Sheet
        open={!!selectedStage}
        title={selectedStage?.title || l.stageSheetTitle}
        onClose={() => setSelectedStageId(null)}
        closeLabel={l.closeLabel}
        actions={
          l.saveStage ? (
            <Button variant="primary" onClick={() => setSelectedStageId(null)} data-testid="stage-save">
              {l.saveStage}
            </Button>
          ) : undefined
        }
      >
        {selectedStage ? (
          <StageEditor
            stage={selectedStage}
            currency={currency}
            onTitleChange={(title) => patchStage(selectedStage.id, { title })}
            onAmountChange={(amount) => editAmount(selectedStage.id, amount)}
            onDurationChange={(durationDays) => patchStage(selectedStage.id, { durationDays })}
            // Новый пункт — БЕЗ требования доказательства (решение владельца
            // 05.09; ADR-164: required_evidence — рекомендация, не гейт).
            // Требование включается вручную переключателем на строке пункта.
            onAddChecklist={(text) =>
              patchStage(selectedStage.id, { checklist: [...selectedStage.checklist, { id: nid('cl'), text, requiredEvidence: false }] })
            }
            onDeleteChecklist={(id) => patchStage(selectedStage.id, { checklist: selectedStage.checklist.filter((c) => c.id !== id) })}
            onToggleChecklistEvidence={(id, requiredEvidence) =>
              patchStage(selectedStage.id, {
                checklist: selectedStage.checklist.map((c) => (c.id === id ? { ...c, requiredEvidence } : c)),
              })
            }
            onOpenMaterials={() => setMaterialsStageId(selectedStage.id)}
            onOpenPayment={() => setPaymentStageId(selectedStage.id)}
            labels={l.stageEditor}
            showDuration={showDuration}
            showMaterials={showMaterials}
            showPayment={showPayment}
            showChecklist={isStageChecklistEditable ? isStageChecklistEditable(selectedStage) : true}
            checklistSuggestions={checklistSuggestions}
          />
        ) : null}
      </Sheet>

      {materialsStage ? (
        <MaterialsModal
          open
          onClose={() => setMaterialsStageId(null)}
          catalog={catalog}
          units={units}
          currency={currency}
          items={materialsStage.materials}
          onAdd={(m) => patchStage(materialsStage.id, { materials: [...materialsStage.materials, { ...m, id: nid('mat') }] })}
          onUpdate={(id, m) =>
            patchStage(materialsStage.id, {
              materials: materialsStage.materials.map((x) => (x.id === id ? { ...m, id } : x)),
            })
          }
          onDelete={(id) => patchStage(materialsStage.id, { materials: materialsStage.materials.filter((m) => m.id !== id) })}
          onDone={() => setMaterialsStageId(null)}
          {...(materialOtherRef ? { otherRef: materialOtherRef } : {})}
          labels={l.materialsModal}
        />
      ) : null}

      {paymentStage ? (
        <PaymentModal
          open
          onClose={() => setPaymentStageId(null)}
          amount={{ amount: paymentStage.amount || '0.00', currency }}
          advance={paymentStage.advance}
          advancePercent={paymentStage.advancePercent}
          onChange={(advance, advancePercent) => patchStage(paymentStage.id, { advance, advancePercent })}
          onDone={() => setPaymentStageId(null)}
          labels={l.paymentModal}
        />
      ) : null}
    </div>
  );
}
