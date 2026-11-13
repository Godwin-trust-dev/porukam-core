import { Badge, type BadgeTone } from './Badge';
import styles from './ArchiveHeader.module.css';

export interface ArchiveHeaderProps {
  contractNo: string;
  counterparty: string;
  statusLabel: string;
  statusTone: BadgeTone;
}

/** Шапка экспорта архива (DEV-12 §3) — статус текст+цвет, не только цвет (§7 CLAUDE.md). */
export function ArchiveHeader({ contractNo, counterparty, statusLabel, statusTone }: ArchiveHeaderProps): JSX.Element {
  return (
    <div className={styles.head} data-testid="archive-header">
      <div className={styles.top}>
        <h1 className={styles.title}>{contractNo}</h1>
        <Badge tone={statusTone} dot>
          {statusLabel}
        </Badge>
      </div>
      <p className={styles.meta}>{counterparty}</p>
    </div>
  );
}
