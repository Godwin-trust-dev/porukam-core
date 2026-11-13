import { Card } from './Card';
import { Button } from './Button';
import { Icon } from './Icon';
import styles from './BackupOption.module.css';

export interface BackupOptionProps {
  title: string;
  text: string;
  connectLabel: string;
  skipLabel: string;
  connected: boolean;
  connectedLabel: string;
  loading?: boolean;
  error?: string;
  onConnect: () => void;
  onSkip: () => void;
}

/**
 * Шаг «Бэкап» (BackupStep, DEV-auth-onboarding §6) — опционален, «Позже» не
 * блокирует онбординг. Отдельный минимальный OAuth-consent на Drive scope
 * (не переиспользует вход через Google, ADR-060 §8).
 */
export function BackupOption({
  title,
  text,
  connectLabel,
  skipLabel,
  connected,
  connectedLabel,
  loading,
  error,
  onConnect,
  onSkip,
}: BackupOptionProps): JSX.Element {
  return (
    <Card className={styles.card}>
      <h3 className={styles.title}>{title}</h3>
      <p className={styles.text}>{text}</p>
      {error ? (
        <p className={styles.error} role="alert">
          {error}
        </p>
      ) : null}
      {connected ? (
        <div className={styles.connected} data-testid="backup-connected">
          <Icon name="verified" size={20} />
          <span>{connectedLabel}</span>
        </div>
      ) : (
        <div className={styles.actions}>
          <Button variant="primary" onClick={onConnect} loading={loading}>
            {connectLabel}
          </Button>
          <Button variant="ghost" onClick={onSkip} disabled={loading}>
            {skipLabel}
          </Button>
        </div>
      )}
    </Card>
  );
}
