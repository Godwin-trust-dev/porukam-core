import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import styles from './Button.module.css';

export type ButtonVariant = 'primary' | 'secondary' | 'teal' | 'spark' | 'ghost' | 'link' | 'destructive' | 'outline' | 'outline-danger' | 'outline-ink';
export type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className'> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  block?: boolean;
  loading?: boolean;
  leftIcon?: ReactNode;
  className?: string;
}

/**
 * Кнопка (Po_Rukam_Icons_Buttons.html): состояния default/hover/active/disabled/loading.
 * Правило: одна главная (primary/янтарь) кнопка на экран. Тач-таргет ≥ 44×44 (§5.4).
 *
 * Модификатор `data-quiet` к `variant="link"` (решение владельца 07.09) —
 * «тихое» опасное действие («Отозвать», «Отклонить»): без заливки и рамки,
 * приглушённым текстом, красное только на наведении. Ставится атрибутом, а не
 * новым вариантом; на тёмном паспорт-рейле (`data-surface="ink"`) светлеет
 * само — см. Button.module.css.
 */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'primary', size = 'md', block, loading, leftIcon, disabled, children, className, ...rest },
  ref,
) {
  const classes = [
    styles.btn,
    styles[variant],
    size !== 'md' ? styles[size] : '',
    block ? styles.block : '',
    loading ? styles.loading : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <button
      ref={ref}
      className={classes}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? <span className={styles.spinner} aria-hidden="true" /> : null}
      {leftIcon}
      {children}
    </button>
  );
});
