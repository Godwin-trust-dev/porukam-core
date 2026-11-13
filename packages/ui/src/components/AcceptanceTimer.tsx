import { Icon } from './Icon';
import styles from './AcceptanceTimer.module.css';

export interface AcceptanceTimerProps {
  /** Уже отформатированное значение («42 ч осталось») — считает страница. */
  valueLabel: string;
  /** «Автоприёмка, если не ответить» — нейтральный тон, не паника (§3 задания). */
  hint: string;
}

/**
 * Таймер приёмки (DEV-04 §2): смысл не кодируется цветом — текст рядом с
 * иконкой (§7 а11y). Нейтральный тон по хай-фай, без янтарного акцента.
 */
export function AcceptanceTimer({ valueLabel, hint }: AcceptanceTimerProps): JSX.Element {
  return (
    <div className={styles.timer} role="status">
      <Icon name="in-progress" size={24} className={styles.icon} />
      <div>
        <p className={styles.value}>{valueLabel}</p>
        <p className={styles.hint}>{hint}</p>
      </div>
    </div>
  );
}
