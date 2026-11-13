import { Button } from './Button';
import { Sheet } from './Sheet';
import styles from './DriveBackupPrompt.module.css';

export interface DriveBackupPromptProps {
  open: boolean;
  title: string;
  text: string;
  connectLabel: string;
  laterLabel: string;
  closeLabel: string;
  onConnect: () => void;
  onLater: () => void;
  connecting?: boolean;
  errorText?: string;
}

/**
 * Мягкий промпт Drive-бэкапа на первой сдаче (DEV-11 §4): «Позже» НЕ блокирует сдачу —
 * закрывает промпт так же, как «Подключить Drive», просто без подключения.
 */
export function DriveBackupPrompt({
  open,
  title,
  text,
  connectLabel,
  laterLabel,
  closeLabel,
  onConnect,
  onLater,
  connecting,
  errorText,
}: DriveBackupPromptProps): JSX.Element | null {
  return (
    <Sheet
      open={open}
      title={title}
      onClose={onLater}
      closeLabel={closeLabel}
      actions={
        <>
          <Button variant="ghost" onClick={onLater} disabled={connecting} data-testid="drive-prompt-later">
            {laterLabel}
          </Button>
          <Button variant="primary" onClick={onConnect} loading={connecting} data-testid="drive-prompt-connect">
            {connectLabel}
          </Button>
        </>
      }
    >
      <p className={styles.text}>{text}</p>
      {errorText ? (
        <p className={styles.error} role="alert">
          {errorText}
        </p>
      ) : null}
    </Sheet>
  );
}
