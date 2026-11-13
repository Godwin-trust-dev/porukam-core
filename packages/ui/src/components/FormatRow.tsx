import { Badge } from './Badge';
import { Icon } from './Icon';
import styles from './FormatRow.module.css';

export interface FormatRowProps {
  pdfLabel: string;
  pdfHint: string;
  pdfSizeLabel?: string;
  /** «Скоро» — PDF-оглавления у бэка нет (`format.pdf=false`, ADR-139 §2): плитка приглушена, бейдж вместо размера. */
  pdfSoonLabel?: string;
  zipLabel: string;
  zipHint: string;
  zipSizeLabel?: string;
}

/** Форматы пакета (DEV-12 §3) — PDF (отчёт с оглавлением) и ZIP (файлы + манифест). */
export function FormatRow({ pdfLabel, pdfHint, pdfSizeLabel, pdfSoonLabel, zipLabel, zipHint, zipSizeLabel }: FormatRowProps): JSX.Element {
  return (
    <div className={styles.grid} data-testid="format-row">
      <div className={`${styles.tile} ${pdfSoonLabel ? styles.soon : ''}`} data-testid="format-pdf" aria-disabled={pdfSoonLabel ? true : undefined}>
        <div className={styles.head}>
          <Icon name="contract" size={24} className={styles.icon} />
          {pdfSoonLabel ? <Badge tone="neutral">{pdfSoonLabel}</Badge> : null}
        </div>
        <p className={styles.label}>{pdfLabel}</p>
        <p className={styles.hint}>{pdfHint}</p>
        {pdfSizeLabel && !pdfSoonLabel ? <p className={styles.size}>{pdfSizeLabel}</p> : null}
      </div>
      <div className={styles.tile} data-testid="format-zip">
        <div className={styles.head}>
          <Icon name="attach" size={24} className={styles.icon} />
        </div>
        <p className={styles.label}>{zipLabel}</p>
        <p className={styles.hint}>{zipHint}</p>
        {zipSizeLabel ? <p className={styles.size}>{zipSizeLabel}</p> : null}
      </div>
    </div>
  );
}
