import type { CSSProperties } from 'react';
import { ICON_PATHS, type IconName } from '../icons/paths';
import styles from './Icon.module.css';

export type IconSize = 16 | 20 | 24 | 32 | 48;

export interface IconProps {
  name: IconName;
  /** 16 плотные списки · 20 mobile · 24 desktop/навигация · 32 акценты · 48 пустые состояния (§5.4). */
  size?: IconSize;
  className?: string;
  style?: CSSProperties;
  /** Декоративная по умолчанию; для смысловой — передайте title. */
  title?: string;
  /**
   * RTL-фундамент (DEV-16 §6): пометьте `true` для иконок со смыслом «вперёд/назад»
   * (`back`, шевроны, стрелки) — в `dir="rtl"`-раскладке они зеркалятся автоматически
   * через CSS. Не влияет на символьные/нейтральные иконки (`globe`, `home` и т.п.).
   */
  directional?: boolean;
}

/**
 * Инлайн-SVG. Цвет линии наследуется от текста (currentColor);
 * акценты (искра/галка) заданы токенами внутри paths (§5.4).
 */
export function Icon({ name, size = 24, className, style, title, directional }: IconProps): JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      className={[directional ? styles.directional : '', className ?? ''].filter(Boolean).join(' ') || undefined}
      style={style}
      role={title ? 'img' : undefined}
      aria-hidden={title ? undefined : true}
      aria-label={title}
      focusable="false"
    >
      {title ? <title>{title}</title> : null}
      {ICON_PATHS[name]}
    </svg>
  );
}
