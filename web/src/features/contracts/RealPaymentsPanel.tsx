import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { Money, type RealContract, type RealPayment } from '@porukam/core';
import { Callout, EmptyState, LtrText, Skeleton } from '@porukam/ui';
import { useRealContractPayments } from '../payments/realApi';
import { RealPaymentRow } from '../payments/RealPaymentRow';
import { useFormatters } from '../../shared/formatters';
import { apiErrorText } from '../../shared/apiErrorText';
import { PlatformPaymentNotice } from './PlatformPaymentNotice';
import styles from './RealPaymentsPanel.module.css';

/**
 * Вкладка «Оплаты» карточки договора. Э5, ADR-130: источник — РЕАЛЬНЫЙ
 * платёжный контур `GET /v1/contracts/{id}/payments` (`apps.payments`), а
 * не дерево этапов и не витрина раздела `GET /dashboard/payments`
 * (ADR-109), как было до Э5.
 *
 * Почему источник сменился, а не дополнился: `Payment` — ИСТОЧНИК ПРАВДЫ о
 * деньгах, отметки `Milestone.paid_confirmed_*_at` остались лишь зеркалом
 * (пишет только `apps.payments.services`). Строка вкладки — это СЧЁТ, а не
 * денежный лист: счёт по листу один (ADR-155 §2), но появляется он в разный
 * момент — при `payment_order=before_start` сразу после подписания (оплата
 * до старта этапа), при постоплате только после приёмки листа. Показывать
 * «лист без счёта» строкой значило бы предлагать подтвердить то, чего не
 * выставляли.
 *
 * `direct_platform`/`hold`: партнёра нет, счета не выставляются вовсе —
 * список приезжает ПУСТЫМ, вместо строк остаётся `PlatformPaymentNotice`.
 */

/** Итог по валютам — разные валюты не складываются по построению (`Money`). */
function sumByCurrency(rows: { amount: string; currency: string }[]): Money[] {
  const byCurrency = new Map<string, Money>();
  for (const r of rows) {
    const money = Money.of(r.amount, r.currency);
    const current = byCurrency.get(r.currency);
    byCurrency.set(r.currency, current ? current.add(money) : money);
  }
  return Array.from(byCurrency.values());
}

export interface RealPaymentsPanelProps {
  contract: RealContract;
}

export function RealPaymentsPanel({ contract }: RealPaymentsPanelProps): JSX.Element {
  const { t } = useTranslation();
  const { formatMoney } = useFormatters();
  const navigate = useNavigate();
  const paymentsQ = useRealContractPayments(contract.id);
  const [err, setErr] = useState<string | null>(null);

  const payments: RealPayment[] = paymentsQ.data ?? [];
  // «Всего» — сумма ЖИВЫХ счетов: отменённый счёт обязательством не является
  // и в итоге «сколько предстоит заплатить» его быть не должно.
  const live = payments.filter((p) => p.status !== 'cancelled');
  const total = sumByCurrency(live);
  const paid = sumByCurrency(live.filter((p) => p.status === 'confirmed'));
  const moneyList = (list: Money[]): string => list.map((m) => formatMoney(m)).join(' · ');

  return (
    <div className={styles.wrap} data-testid="payments-panel">
      {err ? <Callout tone="warn">{err}</Callout> : null}
      {paymentsQ.isPending ? <Skeleton width="100%" height={48} /> : null}
      {paymentsQ.error ? <Callout tone="warn">{apiErrorText(paymentsQ.error) ?? t('common.unexpectedErrorTitle')}</Callout> : null}

      <PlatformPaymentNotice paymentMethod={contract.payment_method} />

      {/* Пустое состояние объясняет, КОГДА строки появятся, — а это зависит
          от порядка оплаты (ADR-151): при предоплате счета выставляются на
          подписании, при постоплате — по мере приёмки этапов. */}
      {!paymentsQ.isPending && payments.length === 0 ? (
        <EmptyState title={t(contract.payment_order === 'before_start' ? 'contract.paymentsTab.emptyBeforeStart' : 'contract.paymentsTab.empty')} />
      ) : null}

      {payments.length > 0 ? (
        <ul className={styles.list}>
          {payments.map((payment) => (
            <RealPaymentRow
              key={payment.id}
              payment={payment}
              titleMode="milestone"
              paymentOrder={contract.payment_order}
              onOpenStage={() => navigate(`/contracts/${contract.id}/stages/${payment.milestone_id}`)}
              onError={setErr}
            />
          ))}
        </ul>
      ) : null}

      {total.length > 0 ? (
        <div className={styles.sum} data-testid="payments-sum">
          <div className={styles.sumRow}>
            <span className={styles.sumLabel}>{t('contract.paymentsTab.total')}</span>
            <LtrText as="span" className={styles.sumValue}>
              {moneyList(total)}
            </LtrText>
          </div>
          <div className={styles.sumRow}>
            <span className={styles.sumLabel}>{t('contract.paymentsTab.paidTotal')}</span>
            <LtrText as="span" className={styles.sumValue}>
              {paid.length > 0 ? moneyList(paid) : moneyList(total.map((m) => Money.of('0', m.currency)))}
            </LtrText>
          </div>
        </div>
      ) : null}
    </div>
  );
}
