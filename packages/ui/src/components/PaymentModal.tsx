import { useState } from 'react';
import { Money, formatMoney, percentFromMoney, percentOfMoney, type MoneyLike } from '@porukam/core';
import { Button } from './Button';
import { LtrText } from './LtrText';
import { Callout } from './Callout';
import { TextField } from './Field';
import { Sheet } from './Sheet';
import styles from './PaymentModal.module.css';

export interface PaymentModalLabels {
  title: string;
  cancel: string;
  done: string;
  amountRowLabel: string;
  advanceLabel: string;
  advancePlaceholder: string;
  advancePercentLabel: string;
  advancePercentPlaceholder: string;
  postLabel: string;
  disclaimer: string;
  closeLabel: string;
}

export interface PaymentModalProps {
  open: boolean;
  onClose: () => void;
  /** Сумма этапа — фиксирована, не редактируется в этом окне. */
  amount: MoneyLike;
  advance: MoneyLike | null;
  advancePercent: number | null;
  onChange: (advance: MoneyLike | null, advancePercent: number | null) => void;
  onDone: () => void;
  labels: PaymentModalLabels;
}

/**
 * Оплата этапа (DEV-09 §4.4) — аванс суммой ИЛИ процентом, «после приёмки» и проценты
 * пересчитываются автоматически двусторонне. Оплата вне платформы, без комиссии,
 * платформа не держит деньги (ADR-060) — только план расчёта между сторонами.
 */
export function PaymentModal({ open, onClose, amount, advance, advancePercent, onChange, onDone, labels: l }: PaymentModalProps): JSX.Element {
  const [amountInput, setAmountInput] = useState(advance?.amount ?? '');
  const [percentInput, setPercentInput] = useState(advancePercent != null ? String(advancePercent) : '');

  function fromAmount(raw: string): void {
    setAmountInput(raw);
    const n = Number(raw);
    if (!raw || Number.isNaN(n)) {
      setPercentInput('');
      onChange(null, null);
      return;
    }
    const adv: MoneyLike = { amount: n.toFixed(2), currency: amount.currency };
    const pct = percentFromMoney(amount, adv);
    setPercentInput(String(pct));
    onChange(adv, pct);
  }

  function fromPercent(raw: string): void {
    setPercentInput(raw);
    const n = Number(raw);
    if (!raw || Number.isNaN(n)) {
      setAmountInput('');
      onChange(null, null);
      return;
    }
    const adv = percentOfMoney(amount, n);
    setAmountInput(adv.amount);
    onChange(adv, n);
  }

  const advanceMoney = advance ?? { amount: '0.00', currency: amount.currency };
  const post = Money.from(amount).subtract(Money.from(advanceMoney));

  return (
    <Sheet
      open={open}
      title={l.title}
      onClose={onClose}
      closeLabel={l.closeLabel}
      actions={
        <>
          <Button variant="ghost" onClick={onClose}>
            {l.cancel}
          </Button>
          <Button variant="primary" onClick={onDone} data-testid="payment-done">
            {l.done}
          </Button>
        </>
      }
    >
      <div className={styles.wrap}>
        <div className={styles.fixedRow}>
          <span>{l.amountRowLabel}</span>
          <strong><LtrText as="span">{formatMoney(amount)}</LtrText></strong>
        </div>

        <div className={styles.row2}>
          <TextField label={l.advanceLabel} placeholder={l.advancePlaceholder} inputMode="decimal" value={amountInput} onChange={(e) => fromAmount(e.target.value)} data-testid="advance-amount" />
          <TextField
            label={l.advancePercentLabel}
            placeholder={l.advancePercentPlaceholder}
            inputMode="decimal"
            value={percentInput}
            onChange={(e) => fromPercent(e.target.value)}
            data-testid="advance-percent"
          />
        </div>

        <div className={styles.autoRow}>
          <span>{l.postLabel}</span>
          <strong data-testid="post-amount"><LtrText as="span">{formatMoney(post.toJSON())}</LtrText></strong>
        </div>

        <Callout tone="operator">{l.disclaimer}</Callout>
      </div>
    </Sheet>
  );
}
