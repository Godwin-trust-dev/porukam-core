import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError, type RealContract, type RealPayment } from '@porukam/core';
import { Button, LtrText, TextField } from '@porukam/ui';
import { useFormatters } from '../../shared/formatters';
import { apiErrorText } from '../../shared/apiErrorText';
import { useCancelRealPayment, useConfirmRealPayment } from './realApi';
import {
  canCancel,
  canConfirm,
  isWaitingCounterparty,
  overdueDays,
  paymentCtaKey,
  paymentKindKey,
  paymentStatusInk,
  paymentStatusKey,
  paymentTitleKey,
  type PaymentStatusInk,
} from './realPaymentView';
import styles from './RealPaymentRow.module.css';

/** Оттенок статуса → класс слова (доска B: смысл несут слово и цвет слова,
 * не заливка чипа). */
const STATUS_INK_CLASS: Record<PaymentStatusInk, string | undefined> = {
  paid: styles.statusPaid,
  progress: styles.statusProgress,
  pending: styles.statusPending,
  off: styles.statusOff,
  alert: styles.statusAlert,
};

/**
 * Одна строка платежа (`apps.payments`, ADR-130) — ОДИН компонент на два
 * места: вкладку «Оплаты» карточки договора (`RealPaymentsPanel`, там же
 * «Открыть этап») и блок оплаты экрана этапа (`StagePage` — счёт по листу
 * один, ADR-155 §2). Правила «кому какая кнопка» живут
 * в `realPaymentView.ts` и приезжают с бэка (`my_side`/`confirmed_by_me`),
 * фронт доменное «плательщик — заказчик» не повторяет.
 *
 * Отмена сделана раскрывающейся формой, а не системным `confirm()`:
 * причина (`reason`) уходит в юридически значимое событие
 * `payment.cancelled` и в ленту договора — вводить её надо в поле.
 */
export interface RealPaymentRowProps {
  payment: RealPayment;
  /** Заголовок строки: во вкладке — название этапа, на экране этапа он
   * уже в шапке страницы, там заголовок — вид платежа. */
  titleMode: 'milestone' | 'kind';
  /** `Contract.payment_order` (ADR-151): при `before_start` счёт — УСЛОВИЕ
   * старта этапа, поэтому он не отменяется, а его подпись говорит о сроке
   * («К оплате до старта этапа»), а не о виде платежа. Приезжает пропом:
   * `PaymentSerializer` порядок оплаты не отдаёт — он на договоре. */
  paymentOrder: RealContract['payment_order'];
  /** «Открыть этап» — только во вкладке «Оплаты» (на самом этапе некуда). */
  onOpenStage?: () => void;
  /** `card` — самостоятельная карточка списка (вкладка «Оплаты»); `plain` —
   * строка ВНУТРИ чужой карточки (экран этапа): своя рамка с отступами дала
   * бы карточку в карточке и на 390px выдавила бы содержимое за экран. */
  variant?: 'card' | 'plain';
  onError: (text: string | null) => void;
  /** Дополнительный контент строки (на экране этапа — обе стороны с
   * отметками, `PartyRow`). */
  children?: ReactNode;
}

export function RealPaymentRow({ payment, titleMode, paymentOrder, onOpenStage, onError, children, variant = 'card' }: RealPaymentRowProps): JSX.Element {
  const { t } = useTranslation();
  const { formatMoney } = useFormatters();
  const confirm = useConfirmRealPayment();
  const cancel = useCancelRealPayment();
  const [cancelOpen, setCancelOpen] = useState(false);
  const [reason, setReason] = useState('');

  const overdue = overdueDays(payment);
  const kindLabel = t(paymentKindKey(payment));
  const titleLabel = t(paymentTitleKey(payment, paymentOrder));

  const fail = (e: unknown): void => {
    onError(apiErrorText(e) ?? (e instanceof ApiError ? e.message : String(e)));
  };

  const onConfirm = (): void => {
    onError(null);
    void confirm.mutateAsync(payment.id).catch(fail);
  };

  const onCancel = (): void => {
    onError(null);
    void cancel
      .mutateAsync({ paymentId: payment.id, reason: reason.trim() || undefined })
      .then(() => {
        setCancelOpen(false);
        setReason('');
      })
      .catch(fail);
  };

  return (
    <li className={variant === 'plain' ? `${styles.row} ${styles.plain}` : styles.row} data-testid="payment-row" data-payment-status={payment.status}>
      <div className={styles.head}>
        <div className={styles.body}>
          <h3 className={styles.title}>{titleMode === 'milestone' ? payment.milestone_title : titleLabel}</h3>
          <div className={styles.meta}>
            {titleMode === 'milestone' ? <span className={styles.kind}>{kindLabel}</span> : null}
            <span className={`${styles.status} ${STATUS_INK_CLASS[paymentStatusInk(payment)]}`} data-testid="payment-status">
              {t(paymentStatusKey(payment))}
            </span>
            {overdue !== null ? (
              <span className={`${styles.status} ${styles.statusAlert}`}>{t('contract.paymentsTab.overdue', { count: overdue })}</span>
            ) : null}
          </div>
        </div>
        <LtrText as="span" className={styles.amount}>
          {formatMoney({ amount: payment.amount, currency: payment.currency })}
        </LtrText>
      </div>

      {children}

      {payment.status === 'cancelled' && payment.cancel_reason ? (
        <p className={styles.hint} data-testid="payment-cancel-reason-text">
          {t('contract.paymentsTab.cancelledReason', { reason: payment.cancel_reason })}
        </p>
      ) : null}
      {isWaitingCounterparty(payment) ? <p className={styles.hint}>{t('stage.realPayWaitingCounterparty')}</p> : null}

      <div className={styles.actions}>
        {onOpenStage ? (
          <Button variant="secondary" size="sm" onClick={onOpenStage} data-testid="payment-open-stage">
            {t('contract.paymentsTab.openStage')}
          </Button>
        ) : null}
        {canConfirm(payment) ? (
          <Button variant="primary" size="sm" loading={confirm.isPending} onClick={onConfirm} data-testid="payment-confirm">
            {t(paymentCtaKey(payment))}
          </Button>
        ) : null}
        {canCancel(payment, paymentOrder) && !cancelOpen ? (
          <Button variant="ghost" size="sm" onClick={() => setCancelOpen(true)} data-testid="payment-cancel">
            {t('contract.paymentsTab.cancel')}
          </Button>
        ) : null}
      </div>

      {cancelOpen ? (
        <div className={styles.cancelForm} data-testid="payment-cancel-form">
          <TextField
            label={t('contract.paymentsTab.cancelReasonLabel')}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            maxLength={255}
            data-testid="payment-cancel-reason"
          />
          <div className={styles.actions}>
            <Button variant="primary" size="sm" loading={cancel.isPending} onClick={onCancel} data-testid="payment-cancel-submit">
              {t('contract.paymentsTab.cancelSubmit')}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setCancelOpen(false)} data-testid="payment-cancel-back">
              {t('contract.paymentsTab.cancelBack')}
            </Button>
          </div>
        </div>
      ) : null}
    </li>
  );
}
