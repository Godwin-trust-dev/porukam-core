import type { ReactNode } from 'react';
import styles from './Badge.module.css';

export type BadgeTone = 'neutral' | 'green' | 'teal' | 'amber' | 'red' | 'ink';

export interface BadgeProps {
  tone?: BadgeTone;
  /** `sm` — чип в строке списка (компакт, DEV-20 §2); `md` — везде ещё. */
  size?: 'sm' | 'md';
  children: ReactNode;
  /** Точка-индикатор перед текстом (статус дублируется не только цветом — §12). */
  dot?: boolean;
  icon?: ReactNode;
  /**
   * Подложка, на которой стоит бейдж. На тёмном (`--pr-grad-dark`: паспорт-рейл
   * карточки, DEV-19 §4) полупрозрачные заливки светлых тонов теряют контраст —
   * фон становится непрозрачно-светлым, а тон остаётся тем же цветом текста.
   * Новых цветов это не вводит: палитра ровно та же (DEV-19).
   */
  on?: 'light' | 'dark';
  className?: string;
}

/**
 * Бейдж/чип: уровень верификации, «проверено», «без защиты платежа», сегмент, статус.
 * Смысл не кодируется одним цветом — рядом всегда текст (доступность, §12).
 */
export function Badge({ tone = 'neutral', size = 'md', children, dot, icon, on = 'light', className }: BadgeProps): JSX.Element {
  return (
    <span className={`${styles.badge} ${styles[tone]} ${size === 'sm' ? styles.sm : ''} ${on === 'dark' ? styles.onDark : ''} ${className ?? ''}`}>
      {dot ? <span className={styles.dot} aria-hidden="true" /> : null}
      {icon}
      {children}
    </span>
  );
}
