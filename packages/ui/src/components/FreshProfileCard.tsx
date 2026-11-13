import { Card } from './Card';
import { Button } from './Button';
import { Badge } from './Badge';
import styles from './FreshProfileCard.module.css';

export interface FreshProfileCardProps {
  title: string;
  ageLabel: string;
  dealsLabel: string;
  contactsLabel: string;
  createCtaLabel: string;
  onCreateCta: () => void;
  inviteCtaLabel: string;
  onInviteCta: () => void;
}

/**
 * Честная карточка свежего профиля (§7 DEV-auth-onboarding, «зеркало, а не
 * гарант», док 31 §3): возраст = «сегодня», 0 сделок, 0 контрагентов — не
 * прячем свежесть, показываем её прямо.
 */
export function FreshProfileCard({
  title,
  ageLabel,
  dealsLabel,
  contactsLabel,
  createCtaLabel,
  onCreateCta,
  inviteCtaLabel,
  onInviteCta,
}: FreshProfileCardProps): JSX.Element {
  return (
    <Card className={styles.card} data-testid="fresh-profile-card">
      <div className={styles.head}>
        <h3 className={styles.title}>{title}</h3>
        <Badge tone="amber">{ageLabel}</Badge>
      </div>
      <div className={styles.stats}>
        <span>{dealsLabel}</span>
        <span>{contactsLabel}</span>
      </div>
      <div className={styles.actions}>
        <Button variant="primary" onClick={onCreateCta}>
          {createCtaLabel}
        </Button>
        <Button variant="ghost" onClick={onInviteCta}>
          {inviteCtaLabel}
        </Button>
      </div>
    </Card>
  );
}
