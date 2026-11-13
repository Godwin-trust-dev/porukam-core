import { Icon } from './Icon';
import styles from './SuspendedBanner.module.css';

export interface SuspendedBannerProps {
  title: string;
  text: string;
  /** «Срок сдвинут» — показывается, когда shifted === true (§4). */
  shiftedLabel?: string;
}

/** Приостановка этапа (DEV-11 §3/§4): ждём материалы/доступ, срок сдвигается — нейтральный тон. */
export function SuspendedBanner({ title, text, shiftedLabel }: SuspendedBannerProps): JSX.Element {
  return (
    <div className={styles.banner} data-testid="suspended-banner">
      <Icon name="calendar" size={32} className={styles.icon} />
      <div>
        <h3 className={styles.title}>{title}</h3>
        <p className={styles.text}>{text}</p>
        {shiftedLabel ? <p className={styles.shifted}>{shiftedLabel}</p> : null}
      </div>
    </div>
  );
}
