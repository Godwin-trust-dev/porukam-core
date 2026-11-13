import type { ReactNode } from 'react';
import styles from './WorkArea.module.css';

export interface WorkAreaProps {
  children: ReactNode;
  /** Включить явную 12-колоночную сетку (4 колонки на узком). */
  grid?: boolean;
  className?: string;
}

/**
 * Рабочая область (DEV-19 §1) — центрированный контейнер `--pr-work-max`
 * внутри оболочки. Один на экран: контент не растягивается на всю ширину
 * монитора и не схлопывается в мобильный столбец.
 */
export function WorkArea({ children, grid, className }: WorkAreaProps): JSX.Element {
  return (
    <div className={[styles.area, grid ? styles.grid : '', className ?? ''].filter(Boolean).join(' ')}>
      {children}
    </div>
  );
}
