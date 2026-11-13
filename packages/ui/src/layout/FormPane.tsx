import type { ReactNode } from 'react';
import styles from './FormPane.module.css';

export interface FormPaneProps {
  children: ReactNode;
  className?: string;
}

/**
 * Центрированный контейнер формы (DEV-19 §5) — мастер создания, подписание,
 * приёмка, онбординг-формы. Ширина одна на все формы (`--pr-form-max`), не
 * подобранная поштучно на каждом экране.
 */
export function FormPane({ children, className }: FormPaneProps): JSX.Element {
  return <div className={[styles.pane, className ?? ''].filter(Boolean).join(' ')}>{children}</div>;
}
