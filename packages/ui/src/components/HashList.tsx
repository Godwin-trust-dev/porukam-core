import styles from './HashList.module.css';

export interface HashListRow {
  file: string;
  hash: string;
}

export interface HashListProps {
  rows: HashListRow[];
  /** «time-stamp → RFC 3161 · {дата}» — уже собранная строка, считает страница. */
  timestampLabel: string;
}

/** Пример манифеста (DEV-12 §3): моно-строки `файл → sha256…`, `tabular-nums`/моно для хешей. */
export function HashList({ rows, timestampLabel }: HashListProps): JSX.Element {
  return (
    <div className={styles.block} data-testid="hash-list">
      {rows.map((r) => (
        <p className={styles.row} key={r.file}>
          <span className={styles.file}>{r.file}</span>
          <span className={styles.arrow} aria-hidden="true">
            →
          </span>
          <span className={styles.hash}>{r.hash}</span>
        </p>
      ))}
      <p className={styles.row}>{timestampLabel}</p>
    </div>
  );
}
