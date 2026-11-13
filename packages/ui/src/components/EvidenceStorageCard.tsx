import { Icon } from './Icon';
import { Button } from './Button';
import styles from './EvidenceStorageCard.module.css';

export interface EvidenceStorageCardProps {
  title: string;
  countLabel: string;
  daysLeftLabel: string;
  downloadLabel: string;
  extendLabel: string;
  onDownload?: () => void;
  onExtend?: () => void;
}

/** Хранение доказательств — только у исполнителя (DEV-03 §3). */
export function EvidenceStorageCard({
  title,
  countLabel,
  daysLeftLabel,
  downloadLabel,
  extendLabel,
  onDownload,
  onExtend,
}: EvidenceStorageCardProps): JSX.Element {
  return (
    <div className={styles.card}>
      <Icon name="shield" size={24} className={styles.icon} />
      <div className={styles.text}>
        <h4 className={styles.title}>{title}</h4>
        <p className={styles.meta}>
          {countLabel} · {daysLeftLabel}
        </p>
      </div>
      <div className={styles.actions}>
        {onDownload ? (
          <Button variant="ghost" size="sm" onClick={onDownload}>
            {downloadLabel}
          </Button>
        ) : null}
        {onExtend ? (
          <Button variant="ghost" size="sm" onClick={onExtend}>
            {extendLabel}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
