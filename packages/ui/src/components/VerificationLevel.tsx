import styles from './VerificationLevel.module.css';

export interface VerificationLevelProps {
  level: 0 | 1 | 2 | 3;
  max?: number;
  /** Подпись «Верификация N / 3» — уже переведена вызывающей стороной. */
  label: string;
}

/**
 * Уровень верификации владельца 0–3 сегментами (DEV-02 §2). Заполненные —
 * `--pr-amber-deep`, подпись дублирует уровень текстом (a11y).
 */
export function VerificationLevel({ level, max = 3, label }: VerificationLevelProps): JSX.Element {
  const segments = Array.from({ length: max }, (_, i) => i < level);
  return (
    <div className={styles.wrap} role="img" aria-label={label}>
      <div className={styles.segments} aria-hidden="true">
        {segments.map((filled, i) => (
          <span key={i} className={`${styles.segment} ${filled ? styles.filled : ''}`} />
        ))}
      </div>
      <span className={styles.label}>{label}</span>
    </div>
  );
}
