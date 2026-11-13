import type { ReactNode } from 'react';
import styles from './SectionLabel.module.css';

export interface SectionLabelProps {
  children: ReactNode;
  /** Довесок справа («Все сделки», счётчик). */
  aside?: ReactNode;
  /** Уровень заголовка в структуре экрана. */
  level?: 2 | 3;
  className?: string;
}

/**
 * Надпись раздела списка (финал доска A): капс 12, приглушённый, умеренный
 * трекинг — «АКТИВНЫЕ ДОГОВОРЫ», «ВИДИМОСТЬ», «АККАУНТ». Стоит на креме над
 * поверхностью строк; довесок справа — в той же строке.
 */
export function SectionLabel({ children, aside, level = 2, className }: SectionLabelProps): JSX.Element {
  const Tag = level === 2 ? 'h2' : 'h3';
  return (
    <div className={`${styles.wrap} ${className ?? ''}`}>
      <Tag className={styles.label}>{children}</Tag>
      {aside ? <div className={styles.aside}>{aside}</div> : null}
    </div>
  );
}
