import styles from './SettingsNav.module.css';

export interface SettingsNavItem {
  key: string;
  label: string;
}

export interface SettingsNavProps {
  items: SettingsNavItem[];
  active: string;
  onSelect: (key: string) => void;
  ariaLabel?: string;
}

/** Левая навигация настроек — только desktop (§2, §8); на mobile — drill-in списком, не используется. */
export function SettingsNav({ items, active, onSelect, ariaLabel }: SettingsNavProps): JSX.Element {
  return (
    <nav className={styles.nav} aria-label={ariaLabel}>
      {items.map((item) => (
        <button
          key={item.key}
          type="button"
          className={`${styles.item} ${active === item.key ? styles.active : ''}`}
          aria-current={active === item.key ? 'page' : undefined}
          onClick={() => onSelect(item.key)}
          data-testid={`settings-nav-${item.key}`}
        >
          {item.label}
        </button>
      ))}
    </nav>
  );
}
