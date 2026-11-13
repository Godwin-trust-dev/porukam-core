import { Icon } from './Icon';
import styles from './CommunityPill.module.css';

export interface CommunityPillProps {
  name: string;
  verified: boolean;
  /** aria-подпись галочки верификации для скринридера. */
  verifiedLabel?: string;
}

/**
 * Пилюля объединения (DEV-01 §2): светлый чип — контрастен и на чернильном
 * рейле, и в светлом теле карточки, без отдельного prop surface.
 */
export function CommunityPill({ name, verified, verifiedLabel }: CommunityPillProps): JSX.Element {
  return (
    <span className={styles.pill}>
      {verified ? <Icon name="verified" size={16} className={styles.check} title={verifiedLabel} /> : null}
      {name}
    </span>
  );
}
