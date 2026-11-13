import { Button } from './Button';
import styles from './ExportCta.module.css';

export interface ExportCtaProps {
  /** «Собрать архив» / «Собрать снимок» (при `is_snapshot`) — считает страница. */
  label: string;
  hint: string;
  onClick: () => void;
  loading?: boolean;
  disabled?: boolean;
}

/** Кнопка сборки (DEV-12 §3/§4 ⭐): бесплатно, без пейвола — подпись всегда «Бесплатно · PDF + ZIP». */
export function ExportCta({ label, hint, onClick, loading, disabled }: ExportCtaProps): JSX.Element {
  return (
    <div className={styles.wrap}>
      <Button variant="primary" block onClick={onClick} loading={loading} disabled={disabled} data-testid="export-cta">
        {label}
      </Button>
      <span className={styles.hint}>{hint}</span>
    </div>
  );
}
