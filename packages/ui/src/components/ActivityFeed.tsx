import { Icon } from './Icon';
import type { IconName } from '../icons/paths';
import styles from './ActivityFeed.module.css';

export interface ActivityFeedItem {
  icon: IconName;
  text: string;
  time: string;
}

export interface ActivityFeedProps {
  title: string;
  items: ActivityFeedItem[];
  seeAllLabel: string;
  onSeeAll: () => void;
}

/** Короткая лента событий дашборда + «Все уведомления» (DEV-03 §2). */
export function ActivityFeed({ title, items, seeAllLabel, onSeeAll }: ActivityFeedProps): JSX.Element {
  return (
    <div className={styles.feed}>
      <h3 className={styles.title}>{title}</h3>
      <ul className={styles.list}>
        {items.map((item, i) => (
          <li key={i} className={styles.item}>
            <Icon name={item.icon} size={20} className={styles.icon} />
            <span className={styles.text}>{item.text}</span>
            <span className={styles.time}>{item.time}</span>
          </li>
        ))}
      </ul>
      <button type="button" className={styles.seeAll} onClick={onSeeAll}>
        {seeAllLabel}
      </button>
    </div>
  );
}
