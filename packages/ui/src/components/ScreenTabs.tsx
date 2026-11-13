import type { ReactNode } from 'react';
import { Icon } from './Icon';
import styles from './ScreenTabs.module.css';

export interface ScreenTabItem {
  key: string;
  label: string;
  /** Счётчик у названия («Новые 10»). `0` не рисуем. */
  count?: number;
}

export interface ScreenTabsProps {
  /**
   * Максимум ДВЕ главные вкладки (DEV-20_2 §3). Остальные категории живут
   * в шите по воронке — строка вкладок не должна скроллиться вбок никогда.
   * Третья-четвёртая короткая вкладка допустима только там, где она заведомо
   * влезает (вкладки внутри карточки) — тогда `allowExtra`.
   */
  items: ScreenTabItem[];
  active: string;
  onChange: (key: string) => void;
  ariaLabel?: string;
  /** Кнопка-воронка справа: открывает `FilterSheet`. Без неё вкладки без довеска. */
  onOpenFilters?: () => void;
  filtersLabel?: string;
  /** Есть неснятые фильтры — воронка помечена точкой. */
  filtersActive?: boolean;
  /** Разрешить 3–4 коротких вкладки (вкладки контента карточки, §3). */
  allowExtra?: boolean;
  /**
   * Показать ВСЕ вкладки без воронки (замечание владельца 07.09: за воронкой
   * «Чат», «Переговоры и подписи» и «История» люди не находят). Полоса идёт
   * по содержимому и ПЕРЕНОСИТСЯ на следующий ряд, если не влезла, — вбок не
   * уезжает никогда. Режим для карточки сделки на ОБЕИХ раскладках; в списках
   * (сделки, уведомления) правило «2 (или 4) вкладки + шит по воронке»
   * остаётся в силе — там за воронкой не вкладки, а фильтры.
   */
  showAll?: boolean;
  /** Довесок справа от воронки (напр. «Прочитать все»). */
  aside?: ReactNode;
}

/**
 * Вкладки экрана без горизонтального скролла (DEV-20_2 §3).
 *
 * Правило задачи: **2 главные вкладки + иконка-воронка**, всё остальное
 * (категории, роль, сортировка, период) — в шите по воронке. Поэтому здесь
 * НЕТ `overflow-x: auto`: вкладки делят ширину поровну и усекаются, а не
 * уезжают вбок. Больше двух вкладок (без `allowExtra`) — ошибка раскладки,
 * а не повод включить скролл, поэтому лишние просто не рендерятся.
 *
 * Исключение — `showAll` (карточка сделки, замечание владельца 07.09):
 * вкладки идут по содержимому и без воронки, а если не влезли в ширину —
 * переносятся на следующую строку (на телефоне это 2–3 ряда). Вбок не уезжает
 * ни полоса, ни страница, и ни одна вкладка не спрятана.
 */
export function ScreenTabs({
  items,
  active,
  onChange,
  ariaLabel,
  onOpenFilters,
  filtersLabel,
  filtersActive,
  allowExtra,
  showAll,
  aside,
}: ScreenTabsProps): JSX.Element {
  const visible = showAll ? items : allowExtra ? items.slice(0, 4) : items.slice(0, 2);
  return (
    <div className={`${styles.bar} ${allowExtra ? styles.extra : ''} ${showAll ? styles.all : ''}`}>
      <div className={styles.list} role="tablist" aria-label={ariaLabel}>
        {visible.map((it) => (
          <button
            key={it.key}
            role="tab"
            type="button"
            aria-selected={active === it.key}
            className={`${styles.tab} ${active === it.key ? styles.active : ''}`}
            onClick={() => onChange(it.key)}
            data-testid={`tab-${it.key}`}
          >
            <span className={styles.label}>{it.label}</span>
            {typeof it.count === 'number' && it.count > 0 ? (
              <span className={styles.count}>{it.count}</span>
            ) : null}
          </button>
        ))}
      </div>
      {aside ? <div className={styles.aside}>{aside}</div> : null}
      {onOpenFilters ? (
        <button
          type="button"
          className={styles.funnel}
          aria-label={filtersLabel}
          title={filtersLabel}
          onClick={onOpenFilters}
          data-testid="open-filters"
          data-active={filtersActive || undefined}
        >
          <Icon name="filter" size={20} />
          {filtersActive ? <span className={styles.funnelDot} aria-hidden="true" /> : null}
        </button>
      ) : null}
    </div>
  );
}
