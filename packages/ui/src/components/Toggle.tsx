import { useId } from 'react';
import styles from './Toggle.module.css';

export interface ToggleProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  /** Подпись, дублирующая состояние текстом (a11y — состояние не только цветом). */
  onLabel: string;
  offLabel: string;
  disabled?: boolean;
  label?: string;
  id?: string;
}

/**
 * Переключатель: «вкл» — `--pr-teal`, состояние всегда продублировано текстом рядом.
 * Тач-цель кнопки — 44×44 (§8), сама дорожка визуально тоньше.
 */
export function Toggle({ checked, onChange, onLabel, offLabel, disabled, label, id }: ToggleProps): JSX.Element {
  const autoId = useId();
  const toggleId = id ?? autoId;
  return (
    <div className={styles.wrap}>
      <button
        type="button"
        id={toggleId}
        role="switch"
        aria-checked={checked}
        aria-label={label}
        disabled={disabled}
        className={styles.hit}
        onClick={() => onChange(!checked)}
      >
        <span className={`${styles.track} ${checked ? styles.on : ''}`}>
          <span className={styles.thumb} aria-hidden="true" />
        </span>
      </button>
      <span className={styles.stateText}>{checked ? onLabel : offLabel}</span>
    </div>
  );
}
