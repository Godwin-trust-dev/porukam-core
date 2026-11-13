import { useId, type ReactNode } from 'react';
import { Icon } from './Icon';
import { FieldHelp } from './FieldHelp';
import styles from './HandleField.module.css';

export type HandleFieldStatus = 'idle' | 'checking' | 'available' | 'taken';

export interface HandleFieldProps {
  label: string;
  hint?: string;
  value: string;
  onChange: (value: string) => void;
  status: HandleFieldStatus;
  checkingLabel: string;
  availableLabel: string;
  takenLabel: string;
  placeholder?: string;
  error?: string;
  /** Подсказка «?» у подписи (FieldHelp). */
  help?: ReactNode;
  helpLabel?: string;
}

/**
 * @handle-поле шага «Профиль» (ProfileStep, DEV-auth-onboarding §6) — статус
 * занятости приходит СНАРУЖИ (`status`), компонент не дебаунсит и не
 * запрашивает сеть сам (правило пакета: доменная логика — не здесь).
 */
export function HandleField({
  label,
  hint,
  value,
  onChange,
  status,
  checkingLabel,
  availableLabel,
  takenLabel,
  placeholder,
  error,
  help,
  helpLabel,
}: HandleFieldProps): JSX.Element {
  const id = useId();
  const statusId = `${id}-status`;
  return (
    <div className={styles.wrap}>
      <span className={styles.labelRow}>
        <label className={styles.label} htmlFor={id}>
          {label}
        </label>
        {help ? <FieldHelp label={helpLabel}>{help}</FieldHelp> : null}
      </span>
      <div className={`${styles.field} ${status === 'taken' || error ? styles.invalid : ''}`}>
        <span className={styles.prefix} aria-hidden="true">
          @
        </span>
        <input
          id={id}
          type="text"
          className={styles.input}
          value={value}
          placeholder={placeholder}
          aria-describedby={statusId}
          aria-invalid={status === 'taken' || Boolean(error) || undefined}
          onChange={(e) => onChange(e.target.value.replace(/^@/, ''))}
        />
        <span className={styles.status} id={statusId} data-testid="handle-status">
          {status === 'checking' ? checkingLabel : null}
          {status === 'available' ? (
            <span className={styles.ok}>
              <Icon name="verified" size={16} /> {availableLabel}
            </span>
          ) : null}
          {status === 'taken' ? <span className={styles.taken}>{takenLabel}</span> : null}
        </span>
      </div>
      {error ? (
        <span className={styles.error} role="alert">
          {error}
        </span>
      ) : hint ? (
        <span className={styles.hint}>{hint}</span>
      ) : null}
    </div>
  );
}
