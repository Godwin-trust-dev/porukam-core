import styles from './Logo.module.css';

/** Единственный знак проекта — рукопожатие со вспышкой (DEV-17 §3).
 * Мастер — `marketing/Logo/porukam-logo.png` (888×760, прозрачный); здесь
 * рендерится веб-производная `web/public/brand/porukam-logo.png` (512px).
 * Никаких других файлов-логотипов в коде быть не должно. */
const LOGO_SRC = '/brand/porukam-logo.png';

export interface LogoProps {
  /** `full` — знак + словознак · `mark` — только знак · `app` — знак на ink-плитке. */
  variant?: 'full' | 'mark' | 'app';
  /** Фон, на котором стоит логотип: словознак — ОДНИМ цветом
   * (тёмный фон → крем, светлый → ink; правило на всех языках). */
  on?: 'dark' | 'light';
  /** Высота знака в px (у `app` — сторона плитки). */
  size?: number;
  /**
   * Словознак: приложение передаёт `t('common.appName')`, ui-пакет не знает i18n.
   * 31.08 бренд переведён на латиницу во ВСЕХ локалях (решение владельца), поэтому
   * `common.appName` теперь всюду `Porukam`. Ключ всё равно остаётся локализуемым:
   * словознак — часть интерфейса, и если бренд когда-нибудь получит начертание для
   * другой письменности, менять надо будет пак, а не эту подпись.
   */
  wordmark?: string;
  className?: string;
}

export function Logo({
  variant = 'mark',
  on = 'light',
  size = 32,
  wordmark = 'Porukam',
  className,
}: LogoProps): JSX.Element {
  if (variant === 'app') {
    return (
      <span className={`${styles.tile} ${className ?? ''}`} style={{ width: size, height: size }} aria-hidden="true">
        <img src={LOGO_SRC} alt="" className={styles.mark} style={{ height: Math.round(size * 0.62) }} />
      </span>
    );
  }
  const mark = (
    <img src={LOGO_SRC} alt="" aria-hidden="true" className={styles.mark} style={{ height: size }} />
  );
  if (variant === 'mark') {
    return <span className={`${styles.logo} ${className ?? ''}`}>{mark}</span>;
  }
  return (
    <span className={`${styles.logo} ${className ?? ''}`}>
      {mark}
      <span
        className={`${styles.word} ${on === 'dark' ? styles.wordOnDark : styles.wordOnLight}`}
        style={{ fontSize: Math.round(size * 0.62) }}
      >
        {wordmark}
      </span>
    </span>
  );
}
