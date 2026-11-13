import styles from './GeneratingState.module.css';

export interface GeneratingStateProps {
  title: string;
  /** 0..100 — считает страница. */
  progress: number;
  hint: string;
}

/** Async-генерация (DEV-12 §3/§4): прогресс + «можно уйти — придёт уведомление». */
export function GeneratingState({ title, progress, hint }: GeneratingStateProps): JSX.Element {
  const value = Math.max(0, Math.min(100, Math.round(progress)));
  return (
    <div className={styles.state} data-testid="generating-state" aria-live="polite">
      <span className={styles.spinner} aria-hidden="true" />
      <p className={styles.title}>{title}</p>
      <div className={styles.track} role="progressbar" aria-valuenow={value} aria-valuemin={0} aria-valuemax={100}>
        <div className={styles.fill} style={{ width: `${value}%` }} />
      </div>
      <p className={styles.value}>{value}%</p>
      <p className={styles.hint}>{hint}</p>
    </div>
  );
}
