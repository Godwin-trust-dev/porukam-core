import { Button } from './Button';
import { Icon } from './Icon';
import styles from './StoragePlashka.module.css';

export type StoragePlashkaTone = 'info' | 'ok';

export interface StoragePlashkaProps {
  tone: StoragePlashkaTone;
  title: string;
  text: string;
  /** Показывается только при tone: 'info' (Drive не подключён). */
  connectLabel?: string;
  onConnect?: () => void;
  loading?: boolean;
  /** Показывается только при tone: 'ok' — «✓ копия в Drive». */
  connectedBadge?: string;
}

/**
 * Честная плашка хранения (DEV-11 §3/§8, ADR-060 §8): оригинал у пользователя,
 * платформа хранит хеш+метку+миниатюру, BYO Google Drive — нейтральный тон, не давление.
 */
export function StoragePlashka({ tone, title, text, connectLabel, onConnect, loading, connectedBadge }: StoragePlashkaProps): JSX.Element {
  return (
    <div className={styles.card} data-tone={tone} data-testid="storage-plashka">
      <Icon name={tone === 'ok' ? 'verified' : 'shield'} size={24} className={styles.icon} />
      <div className={styles.body}>
        <h4 className={styles.title}>{title}</h4>
        <p className={styles.text}>{text}</p>
        {tone === 'info' && connectLabel && onConnect ? (
          <Button variant="ghost" size="sm" onClick={onConnect} loading={loading}>
            {connectLabel}
          </Button>
        ) : null}
        {tone === 'ok' && connectedBadge ? (
          <span className={styles.connected}>
            <Icon name="verified" size={16} /> {connectedBadge}
          </span>
        ) : null}
      </div>
    </div>
  );
}
