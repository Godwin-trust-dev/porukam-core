import { Button } from './Button';
import styles from './CookieBanner.module.css';

export interface CookieBannerProps {
  text: string;
  acceptAllLabel: string;
  necessaryOnlyLabel: string;
  onAcceptAll: () => void;
  onNecessaryOnly: () => void;
}

/**
 * Cookie-баннер (§3 DEV-auth-onboarding, privacy-first): по умолчанию
 * действуют только необходимые cookie БЕЗ клика — «Принять все» это ЯВНОЕ
 * действие пользователя, не молчаливый дефолт. Видимость баннера решает
 * вызывающий код (уже сохранённый выбор — баннер не рендерится вовсе).
 */
export function CookieBanner({
  text,
  acceptAllLabel,
  necessaryOnlyLabel,
  onAcceptAll,
  onNecessaryOnly,
}: CookieBannerProps): JSX.Element {
  return (
    <div className={styles.banner} role="region" aria-label={text} data-testid="cookie-banner">
      <p className={styles.text}>{text}</p>
      <div className={styles.actions}>
        <Button variant="ghost" size="sm" onClick={onNecessaryOnly}>
          {necessaryOnlyLabel}
        </Button>
        <Button variant="primary" size="sm" onClick={onAcceptAll}>
          {acceptAllLabel}
        </Button>
      </div>
    </div>
  );
}
