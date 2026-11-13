import styles from './Spark.module.css';

export interface SparkProps {
  size?: number;
  /** Смысловая подпись для скринридера (событие доверия). */
  title?: string;
}

/**
 * Искра «Ударить по рукам» — 4-лучевая вспышка. Появляется только на доверии/
 * подтверждении (§5.1). Анимация 0.4s, отключается при prefers-reduced-motion (§12).
 */
export function Spark({ size = 64, title }: SparkProps): JSX.Element {
  return (
    <span className={styles.wrap} style={{ width: size, height: size }} role={title ? 'img' : undefined} aria-label={title}>
      <span className={styles.halo} aria-hidden="true" />
      <svg viewBox="0 0 24 24" width={size * 0.7} height={size * 0.7} className={styles.star} aria-hidden={title ? undefined : true}>
        <path d="M12 1 L15.08 8.92 L23 12 L15.08 15.08 L12 23 L8.92 15.08 L1 12 L8.92 8.92 Z" fill="currentColor" />
      </svg>
    </span>
  );
}
