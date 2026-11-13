import { useRef } from 'react';
import styles from './PeriodFilter.module.css';

export type PeriodFilterValue = 'day' | 'week' | 'month' | 'halfyear';

export interface PeriodFilterProps {
  value: PeriodFilterValue;
  onChange: (value: PeriodFilterValue) => void;
  labels: Record<PeriodFilterValue, string>;
  ariaLabel?: string;
}

const ORDER: PeriodFilterValue[] = ['day', 'week', 'month', 'halfyear'];

/**
 * Сегмент периода (DEV-03 §2): день/неделя/месяц/полгода, дефолт — месяц
 * (задаётся страницей через `value`). Доступен с клавиатуры — roving tabindex.
 */
export function PeriodFilter({ value, onChange, labels, ariaLabel }: PeriodFilterProps): JSX.Element {
  const refs = useRef<Partial<Record<PeriodFilterValue, HTMLButtonElement | null>>>({});

  function onKeyDown(e: React.KeyboardEvent<HTMLButtonElement>, current: PeriodFilterValue): void {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const idx = ORDER.indexOf(current);
    const delta = e.key === 'ArrowRight' ? 1 : -1;
    const next = ORDER[(idx + delta + ORDER.length) % ORDER.length]!;
    onChange(next);
    refs.current[next]?.focus();
  }

  return (
    <div className={styles.filter} role="tablist" aria-label={ariaLabel}>
      {ORDER.map((period) => (
        <button
          key={period}
          ref={(el) => {
            refs.current[period] = el;
          }}
          type="button"
          role="tab"
          aria-selected={value === period}
          tabIndex={value === period ? 0 : -1}
          className={`${styles.tab} ${value === period ? styles.active : ''}`}
          onClick={() => onChange(period)}
          onKeyDown={(e) => onKeyDown(e, period)}
          data-testid={`period-filter-${period}`}
        >
          {labels[period]}
        </button>
      ))}
    </div>
  );
}
