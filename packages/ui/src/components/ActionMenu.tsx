import { useEffect, useRef, useState } from 'react';
import { Icon } from './Icon';
import styles from './ActionMenu.module.css';

export interface ActionMenuItem {
  key: string;
  label: string;
  destructive?: boolean;
  /** Помечено как быстрое для свайпа (`SwipeActions`); меню показывает все пункты одинаково. */
  quick?: boolean;
  onSelect: () => void;
}

export interface ActionMenuProps {
  items: ActionMenuItem[];
  triggerLabel: string;
  /** Открыть меню сразу (витрина/тесты) — по умолчанию закрыто. */
  initialOpen?: boolean;
}

/**
 * Меню действий «⋯» (DEV-13 §5/§7) — desktop-вариант (anchored dropdown, role="menu").
 * Mobile использует `Sheet` с тем же списком действий — разные компоненты по CSS-брейкпоинту
 * (тот же приём, что сайдбар/нижняя навигация оболочки), не JS-переключение.
 */
export function ActionMenu({ items, triggerLabel, initialOpen = false }: ActionMenuProps): JSX.Element {
  const [open, setOpen] = useState(initialOpen);
  const wrapRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent): void {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') {
        setOpen(false);
        triggerRef.current?.focus();
      }
    }
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className={styles.wrap} ref={wrapRef} data-testid="action-menu">
      <button
        type="button"
        ref={triggerRef}
        className={styles.trigger}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={triggerLabel}
        data-testid="action-menu-trigger"
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
      >
        <Icon name="more" size={20} />
      </button>
      {open ? (
        <div role="menu" className={styles.menu} aria-label={triggerLabel}>
          {items.map((it) => (
            <button
              key={it.key}
              type="button"
              role="menuitem"
              className={`${styles.item} ${it.destructive ? styles.destructive : ''}`}
              onClick={(e) => {
                e.stopPropagation();
                setOpen(false);
                it.onSelect();
              }}
            >
              {it.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
