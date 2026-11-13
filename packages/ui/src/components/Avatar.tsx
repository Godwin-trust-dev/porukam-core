import styles from './Avatar.module.css';

export interface AvatarProps {
  /** Хендл (с «@» или без) — сеть для цвета и источник инициалов. */
  handle?: string;
  /** Имя — если задано, инициалы берутся из него. */
  name?: string;
  /** Фото; без него — инициалы на цветном круге. */
  src?: string;
  /** Диаметр в px. По умолчанию — аватар-лид строки списка (`--pr-d-avatar`). */
  size?: number;
  /** a11y: без alt аватар декоративный (рядом всегда есть имя текстом). */
  alt?: string;
  className?: string;
}

/**
 * Пять средних тонов финал доски A + белая буква поверх. Аватар декоративен
 * (`aria-hidden`, рядом имя текстом), поэтому контраст буквы AA не нормируется.
 */
const FILLS = [
  'var(--pr-avatar-1)',
  'var(--pr-avatar-2)',
  'var(--pr-avatar-3)',
  'var(--pr-avatar-4)',
  'var(--pr-avatar-5)',
];

export function avatarHash(input: string): number {
  let h = 0;
  for (let i = 0; i < input.length; i += 1) h = (h * 31 + input.charCodeAt(i)) >>> 0;
  return h;
}

export function avatarInitials(handle?: string, name?: string): string {
  const source = (name ?? handle ?? '').replace(/^@/, '').trim();
  if (!source) return '•';
  const parts = source.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0]![0]! + parts[1]![0]!).toUpperCase();
  return source.slice(0, 2).toUpperCase();
}

/**
 * Аватар (DEV-20 §2/§6): фото либо инициалы на цветном круге. Лид строки
 * списка — именно человек, а не плитка типа договора и не крупный значок.
 * Цвет круга детерминирован (хеш хендла/имени): один и тот же контрагент
 * всегда одного цвета — по нему строка узнаётся быстрее, чем по тексту.
 */
export function Avatar({ handle, name, src, size, alt, className }: AvatarProps): JSX.Element {
  const box = size ? { width: size, height: size } : undefined;
  if (src) {
    return <img src={src} alt={alt ?? ''} className={`${styles.img} ${className ?? ''}`} style={box} />;
  }
  const seed = handle || name || '?';
  const fill = FILLS[avatarHash(seed) % FILLS.length];
  return (
    <span
      className={`${styles.placeholder} ${className ?? ''}`}
      style={{ ...box, background: fill, ...(size ? { fontSize: size * 0.38 } : null) }}
      role={alt ? 'img' : undefined}
      aria-label={alt}
      aria-hidden={alt ? undefined : true}
    >
      {avatarInitials(handle, name)}
    </span>
  );
}
