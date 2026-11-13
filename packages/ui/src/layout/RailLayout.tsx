import type { ReactNode } from 'react';
import styles from './RailLayout.module.css';

export interface RailLayoutProps {
  children: ReactNode;
  /** Правый рейл: деньги/период, мини-профиль (DEV-19 §3). */
  rail: ReactNode;
  /** Доступное имя рейла (aria-label у `<aside>`). */
  railLabel: string;
}

/**
 * Дашборд-раскладка (DEV-19 §3, эталон №4 блок 1): главный столбец +
 * правый рейл `--pr-rail-side`. На `<1024` — один столбец, рейл под ним.
 */
export function RailLayout({ children, rail, railLabel }: RailLayoutProps): JSX.Element {
  return (
    <div className={styles.wrap}>
      <div className={styles.main}>{children}</div>
      <aside className={styles.rail} aria-label={railLabel} data-testid="dashboard-rail">
        {rail}
      </aside>
    </div>
  );
}
