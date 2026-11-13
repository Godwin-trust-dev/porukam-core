import { Button } from './Button';
import { Icon } from './Icon';
import styles from './ReadyState.module.css';

export interface ReadyStateProps {
  title: string;
  pdfLabel: string;
  pdfSizeLabel: string;
  onDownloadPdf: () => void;
  zipLabel: string;
  zipSizeLabel: string;
  onDownloadZip: () => void;
  /** «Ссылки активны N дней · собрать заново можно всегда» — undefined, если нет `expires_at`. */
  expiresLabel?: string;
  readmeHint?: string;
}

/** Готово (DEV-12 §3/§4): скачать PDF/ZIP с размерами, срок жизни ссылок (не оригиналов), README. */
export function ReadyState({
  title,
  pdfLabel,
  pdfSizeLabel,
  onDownloadPdf,
  zipLabel,
  zipSizeLabel,
  onDownloadZip,
  expiresLabel,
  readmeHint,
}: ReadyStateProps): JSX.Element {
  return (
    <div className={styles.state} data-testid="ready-state">
      <div className={styles.head}>
        <Icon name="verified" size={32} className={styles.icon} />
        <h3 className={styles.title}>{title}</h3>
      </div>
      <div className={styles.downloads}>
        <Button variant="secondary" block onClick={onDownloadPdf} data-testid="download-pdf">
          {pdfLabel} · <span className={styles.size}>{pdfSizeLabel}</span>
        </Button>
        <Button variant="secondary" block onClick={onDownloadZip} data-testid="download-zip">
          {zipLabel} · <span className={styles.size}>{zipSizeLabel}</span>
        </Button>
      </div>
      {expiresLabel ? <p className={styles.expires}>{expiresLabel}</p> : null}
      {readmeHint ? <p className={styles.readme}>{readmeHint}</p> : null}
    </div>
  );
}
