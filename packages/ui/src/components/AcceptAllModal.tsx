import { Button } from './Button';
import { Modal } from './Modal';
import styles from './AcceptAllModal.module.css';

export interface AcceptAllChange {
  id: string;
  itemLabel: string;
  fromValue: string;
  toValue: string;
}

export interface AcceptAllModalProps {
  open: boolean;
  title: string;
  text: string;
  onClose: () => void;
  changes: AcceptAllChange[];
  totalBeforeLabel: string;
  totalBefore: string;
  totalAfterLabel: string;
  totalAfter: string;
  excludedHint?: string;
  closeLabel: string;
  cancelLabel: string;
  confirmLabel: string;
  onConfirm: () => void;
  submitting?: boolean;
}

/**
 * «Принять все» (DEV-10 §5) — только однозначные открытые правки (variants.length===1) +
 * предодобренные без выбора; при финансово значимых — сводка «было → стало» + итог,
 * подтверждение → `confirm_summary: true`. Многовариантные в список не входят (текстом).
 */
export function AcceptAllModal({
  open,
  title,
  text,
  onClose,
  changes,
  totalBeforeLabel,
  totalBefore,
  totalAfterLabel,
  totalAfter,
  excludedHint,
  closeLabel,
  cancelLabel,
  confirmLabel,
  onConfirm,
  submitting,
}: AcceptAllModalProps): JSX.Element | null {
  return (
    <Modal
      open={open}
      title={title}
      onClose={onClose}
      closeLabel={closeLabel}
      actions={
        <>
          <Button variant="ghost" onClick={onClose}>
            {cancelLabel}
          </Button>
          <Button variant="primary" onClick={onConfirm} loading={submitting} data-testid="confirm-accept-all">
            {confirmLabel}
          </Button>
        </>
      }
    >
      <p>{text}</p>
      <div className={styles.list} data-testid="accept-all-changes">
        {changes.map((ch) => (
          <div className={styles.row} key={ch.id}>
            <span className={styles.itemLabel}>{ch.itemLabel}</span>
            <span className={styles.diff}>
              <span className={styles.before}>{ch.fromValue}</span> → <span className={styles.after}>{ch.toValue}</span>
            </span>
          </div>
        ))}
      </div>
      <div className={styles.total}>
        <span>{totalBeforeLabel}</span>
        <strong className={styles.sum}>{totalBefore}</strong>
      </div>
      <div className={styles.total}>
        <span>{totalAfterLabel}</span>
        <strong className={styles.sum}>{totalAfter}</strong>
      </div>
      {excludedHint ? <p className={styles.hint}>{excludedHint}</p> : null}
    </Modal>
  );
}
