import { Icon } from './Icon';
import styles from './NetworkBanner.module.css';

export interface NetworkBannerProps {
  text: string;
}

/**
 * Тонкая полоса «нет сети» (DEV-15 §3): показывается родителем только пока офлайн
 * (`useNetworkStatus`), не паника — `aria-live=polite`, без анимации тревоги.
 */
export function NetworkBanner({ text }: NetworkBannerProps): JSX.Element {
  return (
    <div className={styles.banner} role="status" aria-live="polite">
      <Icon name="offline" size={16} className={styles.icon} />
      <span>{text}</span>
    </div>
  );
}
