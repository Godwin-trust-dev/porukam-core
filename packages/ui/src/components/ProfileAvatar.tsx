import { avatarHash, avatarInitials } from './Avatar';
import styles from './ProfileAvatar.module.css';

export interface ProfileAvatarProps {
  /** Хендл (с «@» или без) — источник плейсхолдера, если нет `src` (§6 DEV-auth-onboarding). */
  handle: string;
  /** Показывается вместо инициалов, если пусто/не задан хендл. */
  name?: string;
  src?: string;
  size?: number;
  /** a11y — декоративный по умолчанию (рядом обычно есть текстовое имя). */
  alt?: string;
}

/** Один из пяти фирменных градиентов токенов — детерминировано по символам хендла/имени. */
const GRADIENTS = ['var(--pr-grad-amber)', 'var(--pr-grad-teal)', 'var(--pr-grad-ink)', 'var(--pr-grad-dark)', 'var(--pr-grad-tile)'];

/**
 * Аватар владельца: реальное изображение из Google (`src`) либо генерируемый
 * плейсхолдер от @handle (детерминированный градиент + инициалы) — §6.
 *
 * Крупный «свой» аватар (профиль, онбординг, шапка) — градиентный. Лид строки
 * списка — другой компонент, `Avatar` (DEV-20 §2): там кружок 34px с тональной
 * заливкой, на которой чернильная буква держит контраст. Общая у них только
 * арифметика (`avatarHash`/`avatarInitials`), второй её копии в проекте нет.
 */
export function ProfileAvatar({ handle, name, src, size = 48, alt }: ProfileAvatarProps): JSX.Element {
  if (src) {
    return <img src={src} alt={alt ?? ''} className={styles.img} style={{ width: size, height: size }} />;
  }
  const seed = handle || name || '?';
  const gradient = GRADIENTS[avatarHash(seed) % GRADIENTS.length];
  return (
    <span
      className={styles.placeholder}
      style={{ width: size, height: size, fontSize: size * 0.38, background: gradient }}
      role={alt ? 'img' : undefined}
      aria-label={alt}
      aria-hidden={alt ? undefined : true}
    >
      {avatarInitials(handle, name)}
    </span>
  );
}
