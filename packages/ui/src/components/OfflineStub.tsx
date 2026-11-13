import { Icon } from './Icon';
import { Button } from './Button';
import styles from './OfflineStub.module.css';

export interface OfflineStubProps {
  title: string;
  text?: string;
  retryLabel?: string;
  onRetry?: () => void;
}

/**
 * Мини-сцена «нет соединения» (DEV-15 §3, §ло-фай 5) — для раздела, которого нет в кэше.
 * Фирстиль (§4.2), не паника; `retry` перечитывает данные — не форсит перезагрузку страницы.
 */
export function OfflineStub({ title, text, retryLabel, onRetry }: OfflineStubProps): JSX.Element {
  return (
    <div className={styles.state} role="status">
      <Icon name="offline" size={48} className={styles.icon} />
      <h3 className={styles.title}>{title}</h3>
      {text ? <p className={styles.text}>{text}</p> : null}
      {retryLabel ? (
        <Button variant="ghost" onClick={onRetry}>
          {retryLabel}
        </Button>
      ) : null}
    </div>
  );
}
