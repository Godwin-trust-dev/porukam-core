import { Icon } from './Icon';
import type { IconName } from '../icons/paths';
import styles from './StatTile.module.css';

export interface StatTileProps {
  icon: IconName;
  label: string;
  badge?: number;
  onClick?: () => void;
}

/** Быстрая плитка хаба владельца (DEV-02 §3): значок, подпись, необязательный бейдж-счётчик. */
export function StatTile({ icon, label, badge, onClick }: StatTileProps): JSX.Element {
  return (
    <button type="button" className={styles.tile} onClick={onClick}>
      <span className={styles.iconWrap}>
        <Icon name={icon} size={24} />
        {typeof badge === 'number' && badge > 0 ? (
          <span className={styles.badge} aria-hidden="true">
            {badge > 99 ? '99+' : badge}
          </span>
        ) : null}
      </span>
      <span className={styles.label}>{label}</span>
      {typeof badge === 'number' && badge > 0 ? (
        <span className={styles.srBadge}>{` (${badge})`}</span>
      ) : null}
    </button>
  );
}
