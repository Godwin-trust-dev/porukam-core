import { Icon } from './Icon';
import styles from './PaymentPolicyLine.module.css';

export interface PaymentPolicyLineProps {
  title: string;
  note: string;
  /** true → перевод без комиссии платформы (зелёный акцент); false → платный перевод (нейтральный тон). */
  positive: boolean;
}

/**
 * Строка политики платежей за перевод (DEV-05-PATCH §2) — сразу под резюме, у обеих
 * сторон. Тон/иконка идут от `paymentPolicy.transferFee.platformTakesCommission`,
 * текст — из `labelKey/noteKey` (i18n), без литералов в этом компоненте.
 */
export function PaymentPolicyLine({ title, note, positive }: PaymentPolicyLineProps): JSX.Element {
  return (
    <div className={styles.line} data-tone={positive ? 'positive' : 'neutral'}>
      <Icon name={positive ? 'pay-protected' : 'wallet'} size={20} className={styles.icon} />
      <div>
        <p className={styles.title}>{title}</p>
        <p className={styles.note}>{note}</p>
      </div>
    </div>
  );
}
