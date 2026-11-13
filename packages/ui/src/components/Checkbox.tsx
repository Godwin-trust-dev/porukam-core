import { useId, type ReactNode } from 'react';
import styles from './Checkbox.module.css';

export interface CheckboxProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: ReactNode;
  hint?: ReactNode;
  id?: string;
  required?: boolean;
  disabled?: boolean;
}

/**
 * Чекбокс общего назначения (согласия, флаги форм) — крупная тач-цель (§10),
 * подпись всегда рядом текстом. Ничего не предзаполняется вызывающим кодом
 * (silence ≠ согласие, §5 DEV-auth-onboarding) — компонент сам дефолт не решает.
 */
export function Checkbox({ checked, onChange, label, hint, id, required, disabled }: CheckboxProps): JSX.Element {
  const autoId = useId();
  const checkboxId = id ?? autoId;
  const hintId = hint ? `${checkboxId}-hint` : undefined;
  return (
    <div className={styles.wrap}>
      <label className={styles.row} htmlFor={checkboxId}>
        <span className={styles.hit}>
          <input
            id={checkboxId}
            type="checkbox"
            checked={checked}
            required={required}
            disabled={disabled}
            aria-describedby={hintId}
            className={styles.input}
            onChange={(e) => onChange(e.target.checked)}
          />
          <span className={styles.box} aria-hidden="true">
            <svg viewBox="0 0 16 16" width={12} height={12}>
              <path d="M3 8.5 6.2 11.5 13 4" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </span>
        </span>
        <span className={styles.label}>{label}</span>
      </label>
      {hint ? (
        <span className={styles.hint} id={hintId}>
          {hint}
        </span>
      ) : null}
    </div>
  );
}
