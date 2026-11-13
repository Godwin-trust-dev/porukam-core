import { Icon } from './Icon';
import { Button } from './Button';
import styles from './InviteBanner.module.css';

export interface InviteBannerProps {
  /** `undefined`/`expired` — приглашение не найдено или истекло (404, §3). */
  variant?: 'valid' | 'expired';
  /** Обязателен для variant: 'valid'. */
  titleText?: string;
  bodyText?: string;
  actionLabel: string;
  onAction: () => void;
  expiredText: string;
}

/**
 * Баннер приглашения на Welcome (`?invite=<token>`, DEV-auth-onboarding §3).
 * После онбординга ведёт сразу на присланный договор — сама навигацию не
 * знает, только сигнализирует действие вызывающему.
 */
export function InviteBanner({
  variant = 'valid',
  titleText,
  bodyText,
  actionLabel,
  onAction,
  expiredText,
}: InviteBannerProps): JSX.Element {
  if (variant === 'expired') {
    return (
      <div className={styles.banner} data-testid="invite-banner-expired" role="alert">
        <Icon name="dispute" size={24} className={styles.iconMuted} />
        <p className={styles.text}>{expiredText}</p>
      </div>
    );
  }
  return (
    <div className={styles.banner} data-testid="invite-banner">
      <Icon name="share" size={24} className={styles.icon} />
      <div className={styles.body}>
        <p className={styles.title}>{titleText}</p>
        {bodyText ? <p className={styles.text}>{bodyText}</p> : null}
      </div>
      <Button variant="teal" size="sm" onClick={onAction}>
        {actionLabel}
      </Button>
    </div>
  );
}
