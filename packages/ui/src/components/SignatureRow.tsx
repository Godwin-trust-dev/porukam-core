import { formatDateTime } from '@porukam/core';
import { Badge } from './Badge';
import { Icon } from './Icon';
import { LtrText } from './LtrText';
import styles from './SignatureRow.module.css';

export type SignatureRowState = 'you' | 'waiting' | 'signed';

export interface SignatureRowProps {
  name: string;
  role: string;
  state: SignatureRowState;
  signedAt?: string;
  /** Право подписи (доверенность/должность) — только для бизнес-стороны. */
  signerNote?: string;
  youLabel: string;
  waitingLabel: string;
  signedLabel: string;
}

/** Адресная подпись стороны (DEV-05 §3) — 3 состояния. */
export function SignatureRow({ name, role, state, signedAt, signerNote, youLabel, waitingLabel, signedLabel }: SignatureRowProps): JSX.Element {
  return (
    <div className={styles.row} data-state={state}>
      <Icon name={state === 'signed' ? 'verified' : 'profile'} size={24} className={styles.icon} />
      <div className={styles.body}>
        <p className={styles.name}>
          {name} <span className={styles.role}>· {role}</span>
        </p>
        {signerNote ? <p className={styles.signerNote}>{signerNote}</p> : null}
        {state === 'signed' && signedAt ? (
          <p className={styles.signedAt}>
            <LtrText as="span">{formatDateTime(signedAt, undefined, undefined, { legal: true })}</LtrText>
          </p>
        ) : null}
      </div>
      <Badge tone={state === 'signed' ? 'green' : state === 'you' ? 'amber' : 'neutral'} dot>
        {state === 'signed' ? signedLabel : state === 'you' ? youLabel : waitingLabel}
      </Badge>
    </div>
  );
}
