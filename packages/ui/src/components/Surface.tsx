import type { ElementType, ReactNode } from 'react';
import styles from './Surface.module.css';

export interface SurfaceProps {
  children: ReactNode;
  /** `ul`/`ol` для списков — тогда прямые дети должны быть `<li>`. */
  as?: ElementType;
  /** Отступы внутри (для НЕ-списочного содержимого: kv-блоки, пояснения). */
  padded?: boolean;
  /** Без внешней рамки — поверхность внутри другой поверхности. */
  flush?: boolean;
  /**
   * Список во всю ширину телефона (финал доска A): на `<1024` поверхность
   * теряет рамку и радиус и выходит за паддинг контента к краям экрана —
   * строки разделены hairline, сверху и снизу тоже hairline. На десктопе —
   * обычная поверхность с рамкой (эталон compact-десктопа).
   */
  bleed?: boolean;
  className?: string;
  'aria-label'?: string;
  'data-testid'?: string;
}

/**
 * Одна белая поверхность списка (DEV-20 §2): радиус `--pr-d-r-surface`,
 * рамка `--pr-line`, а прямые дети разделены hairline'ом ВНУТРИ неё.
 *
 * Принцип задачи: список — это строки на одной плоскости, а НЕ карточка
 * с тенью на каждый элемент. Поэтому строки (`ListRow`) кладутся внутрь
 * `Surface`, а не оборачиваются каждая в свою «коробку».
 */
export function Surface({
  children,
  as: Tag = 'div',
  padded,
  flush,
  bleed,
  className,
  ...rest
}: SurfaceProps): JSX.Element {
  const cls = [styles.surface, padded ? styles.padded : '', flush ? styles.flush : '', bleed ? styles.bleed : '', className ?? '']
    .filter(Boolean)
    .join(' ');
  return (
    <Tag className={cls} {...rest}>
      {children}
    </Tag>
  );
}
