import { Icon } from './Icon';
import { Button } from './Button';
import styles from './InstallBanner.module.css';

export interface InstallBannerProps {
  titleLabel: string;
  installLabel: string;
  dismissAriaLabel: string;
  onInstall: () => void;
  onDismiss: () => void;
}

/**
 * Промо установки на экран (DEV-15 §2, §ло-фай 1): Android/Chromium/desktop — свой баннер
 * поверх `beforeinstallprompt`. Показывается не на загрузке (после ценностного момента) и
 * закрывается насовсем — copy платформо-нейтральна, тот же тон, что у `PushPromo` (№15/DEV-14).
 */
export function InstallBanner({ titleLabel, installLabel, dismissAriaLabel, onInstall, onDismiss }: InstallBannerProps): JSX.Element {
  return (
    <div className={styles.promo} role="note">
      <Icon name="install" size={24} className={styles.icon} />
      <p className={styles.text}>{titleLabel}</p>
      <Button variant="secondary" size="sm" onClick={onInstall} className={styles.cta}>
        {installLabel}
      </Button>
      <button type="button" className={styles.dismiss} aria-label={dismissAriaLabel} onClick={onDismiss}>
        <Icon name="close" size={20} />
      </button>
    </div>
  );
}
