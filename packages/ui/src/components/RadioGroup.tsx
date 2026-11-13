import type { ReactNode } from 'react';
import styles from './RadioGroup.module.css';

export interface RadioGroupOption {
  value: string;
  label: ReactNode;
  badge?: ReactNode;
  hint?: ReactNode;
}

export interface RadioGroupProps {
  options: RadioGroupOption[];
  /** `null` — ничего не выбрано (без дефолта, силентность ≠ выбор, §5 DEV-auth-onboarding). */
  value: string | null;
  onChange: (value: string) => void;
  ariaLabel: string;
  disabled?: boolean;
}

/**
 * Группа выбора «одно из N» карточками (не нативный radio — крупная тач-цель,
 * §10). Общий примитив: `VisibilityChoice`, `PaymentMethodPicker`, `TypePicker`
 * и т.п. могут строиться поверх него.
 */
export function RadioGroup({ options, value, onChange, ariaLabel, disabled }: RadioGroupProps): JSX.Element {
  return (
    <div className={styles.group} role="radiogroup" aria-label={ariaLabel}>
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          role="radio"
          aria-checked={value === opt.value}
          disabled={disabled}
          className={`${styles.option} ${value === opt.value ? styles.selected : ''}`}
          onClick={() => onChange(opt.value)}
        >
          <span className={styles.dot} aria-hidden="true" />
          <span className={styles.body}>
            <span className={styles.labelRow}>
              <span className={styles.label}>{opt.label}</span>
              {opt.badge ? <span className={styles.badge}>{opt.badge}</span> : null}
            </span>
            {opt.hint ? <span className={styles.hint}>{opt.hint}</span> : null}
          </span>
        </button>
      ))}
    </div>
  );
}
