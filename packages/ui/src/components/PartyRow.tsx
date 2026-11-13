import { formatDateTime } from '@porukam/core';
import { Badge } from './Badge';
import { Icon } from './Icon';
import { LtrText } from './LtrText';
import styles from './PartyRow.module.css';

export type PartyRowState = 'signed' | 'pending';

export interface PartyRowProps {
  name: string;
  role: string;
  signState: PartyRowState;
  signedAt?: string;
  signedLabel: string;
  pendingLabel: string;
}

/** Строка стороны договора (DEV-06 §3) — карточка после подписания, обе стороны видны одинаково. */
export function PartyRow({ name, role, signState, signedAt, signedLabel, pendingLabel }: PartyRowProps): JSX.Element {
  return (
    <div className={styles.row} data-state={signState} data-testid="party-row">
      <Icon name={signState === 'signed' ? 'verified' : 'profile'} size={24} className={styles.icon} />
      <div className={styles.body}>
        <p className={styles.name}>
          {name} <span className={styles.role}>· {role}</span>
        </p>
        {signState === 'signed' && signedAt ? (
          <p className={styles.signedAt}>
            <LtrText as="span" data-testid="party-row-signed-at">
              {formatDateTime(signedAt, undefined, undefined, { legal: true })}
            </LtrText>
          </p>
        ) : null}
      </div>
      <Badge tone={signState === 'signed' ? 'green' : 'neutral'} dot>
        {signState === 'signed' ? signedLabel : pendingLabel}
      </Badge>
    </div>
  );
}
