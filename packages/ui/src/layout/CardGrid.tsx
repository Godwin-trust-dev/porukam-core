import type { ReactNode } from 'react';
import styles from './CardGrid.module.css';

export interface CardGridProps {
  children: ReactNode;
  className?: string;
  'data-testid'?: string;
  'aria-label'?: string;
}

/**
 * Грид карточек (DEV-19 §1): 1 → 2 → 3 колонки по ширине контейнера.
 * Заменяет `flex-direction: column`-списки там, где элемент — карточка,
 * а не строка таблицы.
 */
export function CardGrid({ children, className, ...rest }: CardGridProps): JSX.Element {
  return (
    <div className={[styles.grid, className ?? ''].filter(Boolean).join(' ')} {...rest}>
      {children}
    </div>
  );
}
