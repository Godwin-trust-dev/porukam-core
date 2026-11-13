import { Badge, type BadgeTone } from './Badge';
import { Icon } from './Icon';
import { LtrText } from './LtrText';
import styles from './SbpPay.module.css';

export type SbpPayStatus = 'pending' | 'succeeded' | 'failed';

export interface SbpPayProps {
  /** Уже отформатированная сумма (formatPolicyMoney + paymentPolicy.currency). */
  amountLabel: string;
  banks: string[];
  status: SbpPayStatus;
  qrHint: string;
  banksLabel: string;
  statusLabel: string;
}

const STATUS_TONE: Record<SbpPayStatus, BadgeTone> = { pending: 'amber', succeeded: 'green', failed: 'red' };

/**
 * Онлайн-оплата (DEV-07 §2/§3) — QR + список банков, статус движется провайдером
 * (мок: sweep-on-read по таймеру). Кнопки подтверждения нет — фиксация автоматическая.
 */
export function SbpPay({ amountLabel, banks, status, qrHint, banksLabel, statusLabel }: SbpPayProps): JSX.Element {
  return (
    <div className={styles.wrap} data-testid="sbp-pay" data-status={status}>
      <p className={styles.amount}>
        <LtrText as="span">{amountLabel}</LtrText>
      </p>

      <div className={styles.qr} role="img" aria-label={qrHint}>
        <Icon name="stage-pay" size={48} className={styles.qrIcon} />
      </div>

      {banks.length > 0 ? (
        <div className={styles.banks}>
          <p className={styles.banksLabel}>{banksLabel}</p>
          <ul className={styles.bankList}>
            {banks.map((b) => (
              <li key={b}>{b}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <Badge tone={STATUS_TONE[status]} dot>
        {statusLabel}
      </Badge>
    </div>
  );
}
