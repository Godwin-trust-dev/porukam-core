import { Icon } from './Icon';
import { Button } from './Button';
import styles from './UpdateToast.module.css';

export interface UpdateToastProps {
  text: string;
  updateLabel: string;
  dismissAriaLabel: string;
  onUpdate: () => void;
  onDismiss: () => void;
}

/**
 * Тост обновления SW (DEV-15 §4, §ло-фай 6): тихо, внизу экрана, откладывается по «✕»
 * (не форсим — новый SW остаётся `waiting`, пока не нажали «Обновить»).
 */
export function UpdateToast({ text, updateLabel, dismissAriaLabel, onUpdate, onDismiss }: UpdateToastProps): JSX.Element {
  return (
    <div className={styles.toast} role="status" aria-live="polite">
      <Icon name="refresh" size={20} className={styles.icon} />
      <span className={styles.text}>{text}</span>
      <Button variant="secondary" size="sm" onClick={onUpdate}>
        {updateLabel}
      </Button>
      <button type="button" className={styles.dismiss} aria-label={dismissAriaLabel} onClick={onDismiss}>
        <Icon name="close" size={16} />
      </button>
    </div>
  );
}
