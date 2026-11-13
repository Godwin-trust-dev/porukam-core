import { Icon } from './Icon';
import styles from './NextStepSlot.module.css';

export type NextStepSlotVariant = 'action' | 'notice';

export interface NextStepSlotProps {
  /** Без `variant`/`title` слот не рендерится вовсе — «нечего показать» (DEV-02 §4). */
  variant?: NextStepSlotVariant;
  title?: string;
  subtitle?: string;
  onClick?: () => void;
}

/**
 * Динамический слот «следующий шаг/важное» под паспорт-шапкой хаба (DEV-02 §4):
 * приоритет — повышение верификации → важное уведомление → ничего (нет пустой полосы).
 */
export function NextStepSlot({ variant, title, subtitle, onClick }: NextStepSlotProps): JSX.Element | null {
  if (!variant || !title) return null;

  const content = (
    <>
      <Icon name={variant === 'action' ? 'verified' : 'bell'} size={24} className={styles.icon} />
      <div className={styles.text}>
        <span className={styles.title}>{title}</span>
        {subtitle ? <span className={styles.subtitle}>{subtitle}</span> : null}
      </div>
      {onClick ? <Icon name="back" size={16} className={styles.chevron} directional /> : null}
    </>
  );

  if (onClick) {
    return (
      <button type="button" className={`${styles.slot} ${styles[variant]} ${styles.interactive}`} onClick={onClick}>
        {content}
      </button>
    );
  }
  return <div className={`${styles.slot} ${styles[variant]}`}>{content}</div>;
}
