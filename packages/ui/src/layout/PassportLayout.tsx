import type { ReactNode } from 'react';
import styles from './PassportLayout.module.css';

export interface PassportLayoutProps {
  /** Паспорт сделки: статус, стороны, защита, сумма, главные действия. */
  passport: ReactNode;
  /** Тело: вкладки Этапы/Деньги/История/Материалы и их панели. */
  children: ReactNode;
}

/**
 * Карточка договора на десктопе (DEV-19 §4): липкий паспорт-рейл + широкое
 * тело. Раскрытый на десктоп якорный шаблон §4.4 — тот же DOM, что на
 * мобильном, где рейл просто становится верхней шапкой.
 */
export function PassportLayout({ passport, children }: PassportLayoutProps): JSX.Element {
  return (
    <div className={styles.wrap} data-testid="passport-layout">
      <div className={styles.rail}>{passport}</div>
      <div className={styles.body}>{children}</div>
    </div>
  );
}
