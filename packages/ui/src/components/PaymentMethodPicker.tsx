import type { PaymentMethodKind } from '@porukam/core';
import { Icon } from './Icon';
import styles from './PaymentMethodPicker.module.css';

export interface PaymentMethodChoice {
  kind: PaymentMethodKind;
  label: string;
}

export interface PaymentMethodPickerProps {
  /** Способы — из `paymentPolicy.methods` (страница переводит labelKey → готовый текст). */
  methods: PaymentMethodChoice[];
  selected: PaymentMethodKind;
  onSelect: (kind: PaymentMethodKind) => void;
  groupLabel?: string;
}

const METHOD_ICON: Record<PaymentMethodKind, 'wallet' | 'stage-pay'> = {
  cash: 'wallet',
  sbp: 'stage-pay',
};

/**
 * Выбор способа платежа (DEV-07 §2/§3) — состав строго из `paymentPolicy.methods`.
 * Один способ в политике → без переключателя, просто подпись (нечего переключать).
 */
export function PaymentMethodPicker({ methods, selected, onSelect, groupLabel }: PaymentMethodPickerProps): JSX.Element {
  if (methods.length <= 1) {
    const only = methods[0];
    return (
      <div className={styles.singleMethod} data-testid="payment-method-single">
        {only ? <Icon name={METHOD_ICON[only.kind]} size={20} className={styles.singleIcon} /> : null}
        <span>{only?.label}</span>
      </div>
    );
  }

  return (
    <div className={styles.list} role="radiogroup" aria-label={groupLabel} data-testid="payment-method-picker">
      {methods.map((m) => (
        <button
          key={m.kind}
          type="button"
          role="radio"
          aria-checked={selected === m.kind}
          className={`${styles.option} ${selected === m.kind ? styles.optionActive : ''}`}
          onClick={() => onSelect(m.kind)}
          data-testid={`payment-method-${m.kind}`}
        >
          <Icon name={METHOD_ICON[m.kind]} size={20} />
          {m.label}
        </button>
      ))}
    </div>
  );
}
