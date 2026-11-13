import { Button } from './Button';
import styles from './EditContractLink.module.css';

export interface EditContractLinkProps {
  label: string;
  warning: string;
  onEdit: () => void;
  /** Пока не подписано обеими сторонами — доступно (ADR-006); после signed — нет. */
  enabled: boolean;
}

/** Возврат на редактирование (DEV-05 §3) — аннулирует подписи (ADR-006). */
export function EditContractLink({ label, warning, onEdit, enabled }: EditContractLinkProps): JSX.Element {
  return (
    <div className={styles.wrap}>
      <Button variant="ghost" onClick={onEdit} disabled={!enabled} data-testid="edit-contract-link">
        {label}
      </Button>
      {enabled ? <p className={styles.warning}>{warning}</p> : null}
    </div>
  );
}
