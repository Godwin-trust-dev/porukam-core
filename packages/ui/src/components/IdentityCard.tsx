import { Badge } from './Badge';
import { Icon } from './Icon';
import styles from './IdentityCard.module.css';

export interface IdentityCardProps {
  name: string;
  maskedEmail: string;
  provider: 'google';
  verified: boolean;
  providerLabel: string;
  verifiedLabel: string;
  /** «Достаточно аккаунта…» — спокойным текстом, без иконки-предупреждения (§5). */
  accountHint?: string;
  /** Лестница усиления для дорогих сделок — «сверьте документы лично / распечатанная копия» (§5). */
  escalationHint?: string;
}

/**
 * Идентификация по аккаунту (DEV-global-1, DEV-09 §5) — профиль реквизиты не хранит,
 * достаточно подтверждённого входа. Обе строки-подсказки спокойные, без модалок.
 */
export function IdentityCard({
  name,
  maskedEmail,
  provider,
  verified,
  providerLabel,
  verifiedLabel,
  accountHint,
  escalationHint,
}: IdentityCardProps): JSX.Element {
  return (
    <div className={styles.card} data-testid="identity-card">
      <div className={styles.row}>
        <Icon name="verified" size={32} className={styles.icon} />
        <div className={styles.main}>
          <p className={styles.name}>{name}</p>
          <p className={styles.email}>{maskedEmail}</p>
        </div>
        <div className={styles.badges}>
          <Badge tone="neutral">{provider === 'google' ? providerLabel : provider}</Badge>
          {verified ? (
            <Badge tone="green" dot>
              {verifiedLabel}
            </Badge>
          ) : null}
        </div>
      </div>
      {accountHint ? <p className={styles.hint}>{accountHint}</p> : null}
      {escalationHint ? <p className={styles.hint}>{escalationHint}</p> : null}
    </div>
  );
}
