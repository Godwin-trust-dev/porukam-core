import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError, type ContractRole, type RealContractMaterial } from '@porukam/core';
import { Button, Callout, Icon, LtrText } from '@porukam/ui';
import { useUnits } from '../contractNew/api';
import { canMarkHandedOver, canMarkReceived, materialHandoverState } from './materials';
import { useHandOverRealMaterial, useReceiveRealMaterial, useRealMaterials } from './realApi';
import { useFormatters } from '../../shared/formatters';
import styles from './StageMaterials.module.css';

/**
 * Материалы этапа на СТРАНИЦЕ ЭТАПА (ADR-155 §6) — не редактор (тот на
 * карточке, пока договор редактируется), а протокол передачи: у каждого
 * материала заказчика статус «ожидается → передано (дата) → получено (дата)»
 * и кнопка СВОЕЙ стороны. Материалы исполнителя гейт не держат — у них только
 * пометка «поставляет исполнитель», подтверждать нечего.
 *
 * Порядок шагов не обязателен: «Материалы получены» доступна исполнителю и
 * без чужого «передано» (владелец 03.09) — сторона, которой факт НЕВЫГОДЕН
 * (он открывает ей гейт и запускает её же сроки), не должна ждать чужой
 * кнопки.
 */
export function StageMaterials({
  contractId,
  milestoneId,
  myRole,
  anchorId,
}: {
  contractId: string;
  milestoneId: string;
  myRole: ContractRole | undefined;
  anchorId?: string;
}): JSX.Element | null {
  const { t } = useTranslation();
  const { formatDate, formatMoney } = useFormatters();
  const { data: materials } = useRealMaterials(milestoneId);
  const { data: units } = useUnits();
  const handOver = useHandOverRealMaterial(contractId);
  const receive = useReceiveRealMaterial(contractId);
  const [err, setErr] = useState<string | null>(null);

  const list = materials ?? [];
  if (list.length === 0) return null;

  const run = (fn: () => Promise<unknown>): void => {
    setErr(null);
    void fn().catch((e) => setErr(e instanceof ApiError ? e.message : String(e)));
  };
  const unitLabel = (code: string | null): string => (units ?? []).find((u) => u.code === code)?.label ?? code ?? '';

  const stateView = (m: RealContractMaterial): { text: string; className: string | undefined; met: boolean } => {
    switch (materialHandoverState(m)) {
      case 'contractor_supplied':
        return { text: t('stage.materials.byContractor'), className: styles.stateContractor, met: false };
      case 'received':
        return {
          text: t('stage.materials.received', { date: m.received_at ? formatDate(m.received_at, { legal: true }) : '' }),
          className: styles.stateReceived,
          met: true,
        };
      case 'handed_over':
        return {
          text: t('stage.materials.handedOver', { date: m.handed_over_at ? formatDate(m.handed_over_at, { legal: true }) : '' }),
          className: styles.stateHandedOver,
          met: false,
        };
      default:
        return { text: t('stage.materials.expected'), className: styles.stateExpected, met: false };
    }
  };

  return (
    <section className={styles.wrap} id={anchorId} data-testid="stage-materials-handover">
      <h3 className={styles.title}>{t('stage.materials.title')}</h3>
      {err ? <Callout tone="warn">{err}</Callout> : null}
      <ul className={styles.list}>
        {list.map((m) => {
          const view = stateView(m);
          const quantity = m.quantity && Number(m.quantity) > 0 ? `${Number(m.quantity)} ${unitLabel(m.unit)}` : '';
          return (
            <li key={m.id} className={styles.item} data-testid="stage-material-row" data-state={materialHandoverState(m)}>
              <div className={styles.row}>
                <span className={styles.main}>
                  <span className={styles.name}>{m.description}</span>
                  <span className={styles.meta}>
                    {quantity ? `${quantity} · ` : ''}
                    <LtrText as="span">{formatMoney({ amount: m.unit_price, currency: m.unit_price_currency })}</LtrText>
                  </span>
                </span>
                <span className={`${styles.state} ${view.className}`} data-testid="material-state">
                  {view.met ? <Icon name="verified" size={16} /> : null}
                  {view.text}
                </span>
              </div>
              {canMarkHandedOver(m, myRole) || canMarkReceived(m, myRole) ? (
                <div className={styles.actions}>
                  {canMarkHandedOver(m, myRole) ? (
                    <Button
                      variant="outline"
                      size="sm"
                      loading={handOver.isPending}
                      onClick={() => run(() => handOver.mutateAsync(m.id))}
                      data-testid="material-handed-over"
                    >
                      {t('stage.materials.handOverCta')}
                    </Button>
                  ) : null}
                  {canMarkReceived(m, myRole) ? (
                    <Button
                      variant="primary"
                      size="sm"
                      loading={receive.isPending}
                      onClick={() => run(() => receive.mutateAsync(m.id))}
                      data-testid="material-received"
                    >
                      {t('stage.materials.receiveCta')}
                    </Button>
                  ) : null}
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
