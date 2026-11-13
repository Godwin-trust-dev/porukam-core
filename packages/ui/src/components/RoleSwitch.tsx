import { useRef } from 'react';
import styles from './RoleSwitch.module.css';

export type ReputationRoleValue = 'contractor' | 'customer';

export interface RoleSwitchProps {
  value: ReputationRoleValue;
  onChange: (value: ReputationRoleValue) => void;
  contractorLabel: string;
  customerLabel: string;
  ariaLabel?: string;
}

const ORDER: ReputationRoleValue[] = ['contractor', 'customer'];

/**
 * Сегмент «Исполнитель · Заказчик» (DEV-01 §2, §9): доступен с клавиатуры
 * через roving tabindex — стрелки перемещают фокус и выбор, Tab заходит один раз.
 */
export function RoleSwitch({
  value,
  onChange,
  contractorLabel,
  customerLabel,
  ariaLabel,
}: RoleSwitchProps): JSX.Element {
  const labels: Record<ReputationRoleValue, string> = {
    contractor: contractorLabel,
    customer: customerLabel,
  };
  const refs = useRef<Partial<Record<ReputationRoleValue, HTMLButtonElement | null>>>({});

  function onKeyDown(e: React.KeyboardEvent<HTMLButtonElement>, current: ReputationRoleValue): void {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const next: ReputationRoleValue = current === 'contractor' ? 'customer' : 'contractor';
    onChange(next);
    refs.current[next]?.focus();
  }

  return (
    <div className={styles.switch} role="tablist" aria-label={ariaLabel}>
      {ORDER.map((role) => (
        <button
          key={role}
          ref={(el) => {
            refs.current[role] = el;
          }}
          type="button"
          role="tab"
          aria-selected={value === role}
          tabIndex={value === role ? 0 : -1}
          className={`${styles.tab} ${value === role ? styles.active : ''}`}
          onClick={() => onChange(role)}
          onKeyDown={(e) => onKeyDown(e, role)}
          data-testid={`role-switch-${role}`}
        >
          {labels[role]}
        </button>
      ))}
    </div>
  );
}
