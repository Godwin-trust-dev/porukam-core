import { useRef, type KeyboardEvent } from 'react';
import styles from './Segmented.module.css';

export interface SegmentedItem<V extends string> {
  value: V;
  label: string;
  disabled?: boolean;
  'data-testid'?: string;
}

export interface SegmentedProps<V extends string> {
  items: SegmentedItem<V>[];
  value: V | null;
  onChange: (value: V) => void;
  ariaLabel: string;
  /** Весь сегмент недоступен (роль зафиксирована черновиком и т.п.). */
  disabled?: boolean;
  /**
   * Доска B: роли в мастере — тёмная чернильная капсула с БЕЛОЙ пилюлей
   * выбранного (`dark`). Светлый вариант (`light`, по умолчанию) остаётся
   * для уточнения типа договора и прочих форм.
   */
  tone?: 'light' | 'dark';
  className?: string;
}

/**
 * Сегментный переключатель (DEV-20 §6): «Заказчик · Исполнитель»,
 * «Физлицо · Бизнес-профиль», уточнение типа договора.
 *
 * На узком экране переносится в 2 строки (сегменты делят ширину), а не
 * растягивает строку за экран. Клавиатура — roving tabindex: Tab заходит
 * в группу один раз, стрелки двигают выбор.
 */
export function Segmented<V extends string>({
  items,
  value,
  onChange,
  ariaLabel,
  disabled,
  tone = 'light',
  className,
}: SegmentedProps<V>): JSX.Element {
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});
  const activeIndex = Math.max(
    0,
    items.findIndex((i) => i.value === value),
  );

  function onKeyDown(e: KeyboardEvent<HTMLButtonElement>, index: number): void {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const step = e.key === 'ArrowRight' ? 1 : -1;
    const next = items[(index + step + items.length) % items.length];
    if (!next || next.disabled || disabled) return;
    onChange(next.value);
    refs.current[next.value]?.focus();
  }

  return (
    <div
      className={`${styles.group} ${tone === 'dark' ? styles.dark : ''} ${className ?? ''}`}
      role="tablist"
      aria-label={ariaLabel}
    >
      {items.map((item, index) => (
        <button
          key={item.value}
          ref={(el) => {
            refs.current[item.value] = el;
          }}
          type="button"
          role="tab"
          aria-selected={value === item.value}
          tabIndex={index === activeIndex ? 0 : -1}
          disabled={disabled || item.disabled}
          className={`${styles.seg} ${value === item.value ? styles.active : ''}`}
          onClick={() => onChange(item.value)}
          onKeyDown={(e) => onKeyDown(e, index)}
          data-testid={item['data-testid']}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
