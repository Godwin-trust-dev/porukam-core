import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Icon, type IconName } from '@porukam/ui';
import styles from './SectionMenu.module.css';

export interface SectionMenuItem {
  to: string;
  label: string;
  icon: IconName;
  badge?: number;
  active?: boolean;
}

/**
 * Мобильное меню разделов (отсмотр 2026-08-24: «на мобильном непонятно, как
 * переключаться между вкладками — общего перечня, как в левой панели
 * десктопа, нет; левый верхний угол — яркой кнопкой с выпадающим списком и
 * галочкой»). Заголовок страницы в шапке становится янтарной кнопкой с
 * шевроном; список — все разделы сайдбара десктопа (с бейджами), текущий
 * отмечен галочкой. На ≥1024px не рендерится (там сайдбар).
 */
export function SectionMenu({ title, label, items }: { title: string; label: string; items: SectionMenuItem[] }): JSX.Element {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const wrapRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent): void {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') {
        setOpen(false);
        btnRef.current?.focus();
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
    <div className={styles.wrap} ref={wrapRef} data-testid="section-menu">
      <button
        ref={btnRef}
        type="button"
        className={styles.trigger}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        onClick={() => setOpen((v) => !v)}
        data-testid="section-menu-trigger"
      >
        <span className={styles.triggerTitle}>{title}</span>
        <Icon name="chevron-down" size={20} className={open ? styles.chevronOpen : undefined} />
      </button>
      {open ? (
        <ul className={styles.menu} role="menu" aria-label={label} data-testid="section-menu-list">
          {items.map((item) => (
            <li key={item.to} role="none">
              <button
                type="button"
                role="menuitemradio"
                aria-checked={item.active ?? false}
                className={`${styles.item} ${item.active ? styles.itemActive : ''}`}
                onClick={() => {
                  setOpen(false);
                  navigate(item.to);
                }}
                data-testid={`section-menu-item-${item.to === '/' ? 'home' : item.to.slice(1)}`}
              >
                <Icon name={item.icon} size={20} />
                <span className={styles.itemLabel}>{item.label}</span>
                {item.badge ? <span className={styles.badge}>{item.badge > 99 ? '99+' : item.badge}</span> : null}
                {item.active ? <Icon name="verified" size={20} className={styles.check} /> : null}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
