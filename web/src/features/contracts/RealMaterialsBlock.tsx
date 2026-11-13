import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError, type RealContractMaterial } from '@porukam/core';
import { Button, Callout, Icon, LtrText, MaterialsModal } from '@porukam/ui';
import { useMaterialCatalog, useUnits } from '../contractNew/api';
import {
  buildMaterialsModalLabels,
  canMarkHandedOver,
  canMarkReceived,
  materialHandoverState,
  resolveMaterialCatalog,
  serverMaterialId,
  toDraftMaterial,
  toMaterialInput,
} from './materials';
import {
  useCreateRealMaterial,
  useDeleteRealMaterial,
  useHandOverRealMaterial,
  useRealContractView,
  useRealMaterials,
  useReceiveRealMaterial,
  useUpdateRealMaterial,
} from './realApi';
import { useActorStore } from '../actor/actorStore';
import { useCurrentUserId } from '../auth/useAuth';
import { MaterialsChangedBadge, useMaterialsChangedBadge } from './MaterialsChangedBadge';
import { useFormatters } from '../../shared/formatters';
import styles from './RealMaterialsBlock.module.css';

/**
 * Материалы этапа на карточке договора (решение владельца 03.09: «если договор
 * редактируется, то должны быть возможность редактировать и материалы»).
 *
 * Список виден всегда; правка (добавить / изменить / удалить) — только пока
 * договор редактируется, теми же условиями, что структура этапов и чек-лист.
 * После заморозки версии остаётся просмотр — менять материалы можно только
 * допником (Amendment), — и вместо правки появляется ПРОТОКОЛ ПЕРЕДАЧИ
 * (ADR-155 §6): статус «ожидается → передано → получено» и кнопка своей
 * стороны. До подписания протокола нет: передавать нечего, обязательства ещё
 * не возникли.
 */
export function RealMaterialsBlock({
  contractId,
  milestoneId,
  sphereCode,
  currency,
  editable,
}: {
  contractId: string;
  milestoneId: string;
  sphereCode: string | null;
  currency: string;
  editable: boolean;
}): JSX.Element | null {
  const { t } = useTranslation();
  const { formatDate, formatMoney } = useFormatters();
  const { data: materials } = useRealMaterials(milestoneId);
  const { data: units } = useUnits();
  const { data: view } = useRealContractView(contractId);
  const myProfileId = useActorStore((s) => s.activeProfileId);
  const myUserId = useCurrentUserId();
  const handOver = useHandOverRealMaterial(contractId);
  const receive = useReceiveRealMaterial(contractId);
  const [open, setOpen] = useState(false);
  const [handoverErr, setHandoverErr] = useState<string | null>(null);

  const list = materials ?? [];
  // Роль в договоре — РЕАЛЬНАЯ (по `contract.parties`), как на странице этапа:
  // «передал» отмечает сторона-источник, «получил» другая, и показывать чужую
  // кнопку нельзя (бэк вернёт 403 `material_handover_wrong_side`).
  const myRole = view?.contract.parties.find((p) => p.profile_id === myProfileId)?.role;
  // Бейдж «материалы изменены контрагентом» (ADR-156) — на том самом этапе,
  // чьи материалы правили: в «Обзоре» он один на договор, здесь адресный.
  const materialsChanged = useMaterialsChangedBadge({
    contractId,
    events: view?.timeline,
    negotiationStatus: view?.contract.negotiation_status ?? 'draft',
    viewerKey: myProfileId,
    viewerUserId: myUserId,
    viewerRole: myRole ?? null,
    serverSeenAt: view?.contract.materials_seen_at ?? null,
  });
  const changedHere = materialsChanged.visible && materialsChanged.milestoneId === milestoneId;
  const handover = !editable;
  const runHandover = (fn: () => Promise<unknown>): void => {
    setHandoverErr(null);
    void fn().catch((e) => setHandoverErr(e instanceof ApiError ? e.message : String(e)));
  };
  const handoverLabel = (m: RealContractMaterial): string => {
    switch (materialHandoverState(m)) {
      case 'contractor_supplied':
        return t('stage.materials.byContractor');
      case 'received':
        return t('stage.materials.received', { date: m.received_at ? formatDate(m.received_at, { legal: true }) : '' });
      case 'handed_over':
        return t('stage.materials.handedOver', { date: m.handed_over_at ? formatDate(m.handed_over_at, { legal: true }) : '' });
      default:
        return t('stage.materials.expected');
    }
  };
  const unitLabel = (code: string | null): string => (units ?? []).find((u) => u.code === code)?.label ?? code ?? '';
  const sourceLabel = (m: RealContractMaterial): string =>
    m.source === 'customer' ? t('contractNew.materials.suppliedByCustomer') : t('contractNew.materials.suppliedByContractor');
  const baseLabel = (m: RealContractMaterial): string =>
    m.delivery_base === 'prepayment'
      ? t('contractNew.materials.deliveryBasePrepayment')
      : m.delivery_base === 'stage_start'
        ? t('contractNew.materials.deliveryBaseStageStart')
        : t('contractNew.materials.deliveryBaseSigning');

  if (list.length === 0 && !editable && !changedHere) return null;

  return (
    <>
      {changedHere ? (
        <MaterialsChangedBadge
          label={t('contract.materialsChangedBadge')}
          onOpen={materialsChanged.markSeen}
          testId="materials-changed-badge-stage"
        />
      ) : null}
      {handoverErr ? <Callout tone="warn">{handoverErr}</Callout> : null}
      {list.length > 0 ? (
        <ul className={styles.list} data-testid="stage-materials">
          {list.map((m) => (
            <li className={styles.item} key={m.id} data-state={materialHandoverState(m)}>
              <Icon name="wallet" size={16} />
              <span>
                {m.description}
                {m.quantity && Number(m.quantity) > 0 ? ` — ${Number(m.quantity)} ${unitLabel(m.unit)}` : ''}
                {' · '}
                <LtrText as="span">{formatMoney({ amount: m.unit_price, currency: m.unit_price_currency })}</LtrText>
                {t('contractNew.materials.suppliedByMeta', { name: sourceLabel(m) })}
                {m.delivery_days ? t('contractNew.materials.deliveryMeta', { days: m.delivery_days, base: baseLabel(m) }) : ''}
                {handover ? (
                  <span className={styles.handover} data-testid="material-state">
                    {handoverLabel(m)}
                  </span>
                ) : null}
              </span>
              {handover && (canMarkHandedOver(m, myRole) || canMarkReceived(m, myRole)) ? (
                <span className={styles.handoverActions}>
                  {canMarkHandedOver(m, myRole) ? (
                    <Button size="sm" variant="outline" loading={handOver.isPending} onClick={() => runHandover(() => handOver.mutateAsync(m.id))} data-testid="material-handed-over">
                      {t('stage.materials.handOverCta')}
                    </Button>
                  ) : null}
                  {canMarkReceived(m, myRole) ? (
                    <Button size="sm" variant="primary" loading={receive.isPending} onClick={() => runHandover(() => receive.mutateAsync(m.id))} data-testid="material-received">
                      {t('stage.materials.receiveCta')}
                    </Button>
                  ) : null}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}

      {editable ? (
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            // Открыли окно материалов — значит увидели правку контрагента.
            if (changedHere) materialsChanged.markSeen();
            setOpen(true);
          }}
          data-testid="open-materials"
        >
          <Icon name="wallet" size={16} /> {t('contractNew.stageEditor.materialsBtn')}
          {list.length ? ` (${list.length})` : ''}
        </Button>
      ) : null}

      {open ? (
        <MaterialsEditorSheet
          contractId={contractId}
          milestoneId={milestoneId}
          sphereCode={sphereCode}
          currency={currency}
          materials={list}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}

/** Окно правки — ОТДЕЛЬНЫМ компонентом, чтобы каталог материалов и единицы
 * запрашивались только при открытии: карточка договора рисует блок на каждом
 * листе дерева, и держать эти запросы в нём значило бы тянуть справочники
 * ради списка, который и так пришёл с материалами. */
function MaterialsEditorSheet({
  contractId,
  milestoneId,
  sphereCode,
  currency,
  materials,
  onClose,
}: {
  contractId: string;
  milestoneId: string;
  sphereCode: string | null;
  currency: string;
  materials: RealContractMaterial[];
  onClose: () => void;
}): JSX.Element | null {
  const { t } = useTranslation();
  const { data: catalog } = useMaterialCatalog(sphereCode ?? undefined);
  const { data: units } = useUnits();
  const createMaterial = useCreateRealMaterial(contractId);
  const updateMaterial = useUpdateRealMaterial(contractId);
  const deleteMaterial = useDeleteRealMaterial(contractId);
  const [err, setErr] = useState<string | null>(null);

  const run = (fn: () => Promise<unknown>) => void fn().catch((e) => setErr(e instanceof ApiError ? e.message : String(e)));
  const { items: materialCatalog, otherRef } = useMemo(
    () => resolveMaterialCatalog(catalog ?? [], sphereCode ?? ''),
    [catalog, sphereCode],
  );
  const draftItems = useMemo(() => materials.map(toDraftMaterial), [materials]);

  if (!catalog || !units) return null;

  return (
    <>
      {err ? <Callout tone="warn">{err}</Callout> : null}
      <MaterialsModal
        open
        onClose={onClose}
        onDone={onClose}
        catalog={materialCatalog}
        units={units}
        currency={currency}
        otherRef={otherRef}
        items={draftItems}
        onAdd={(item) => run(() => createMaterial.mutateAsync({ milestoneId, input: toMaterialInput({ ...item, id: '' }, currency) }))}
        onUpdate={(id, item) =>
          run(() => updateMaterial.mutateAsync({ materialId: serverMaterialId(id), input: toMaterialInput({ ...item, id }, currency) }))
        }
        onDelete={(id) => run(() => deleteMaterial.mutateAsync(serverMaterialId(id)))}
        labels={buildMaterialsModalLabels(t)}
      />
    </>
  );
}
