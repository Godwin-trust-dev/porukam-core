import styles from './MiniStepper.module.css';

export interface MiniStepperProps {
  done: number;
  total: number;
  /** «3 из 5» — уже отформатировано (i18n-интерполяция) — считает страница. */
  label: string;
}

/** Компактный степпер строки списка (DEV-13 §5) — точки + текст (не только цвет, §9). */
export function MiniStepper({ done, total, label }: MiniStepperProps): JSX.Element {
  const dots = Array.from({ length: Math.max(total, 0) }, (_, i) => i < done);
  return (
    <span className={styles.wrap} data-testid="mini-stepper">
      <span className={styles.dots} aria-hidden="true">
        {dots.map((filled, i) => (
          <span key={i} className={`${styles.dot} ${filled ? styles.dotDone : ''}`} />
        ))}
      </span>
      <span className={styles.label}>{label}</span>
    </span>
  );
}
