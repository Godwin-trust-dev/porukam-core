import { Badge } from './Badge';
import { Button } from './Button';
import styles from './ReviewHeader.module.css';

export interface ReviewHeaderProps {
  title: string;
  statusLabel: string;
  counterpartyName: string;
  viewerRoleLabel: string;
  openCountLabel: string;
  yourTurnCount: number;
  yourTurnLabel?: string;
  menuLabel: string;
  onWithdraw?: () => void;
  withdrawLabel?: string;
  onRejectContract?: () => void;
  rejectLabel?: string;
  /** Без обработчика кнопка чата не рендерится (чат выключен, отсмотр 22.08). */
  onChat?: () => void;
  chatLabel: string;
}

/** Шапка экрана согласования (DEV-10 §3) — счётчики открытых правок/«ваш ход», меню выходов, чат. */
export function ReviewHeader({
  title,
  statusLabel,
  counterpartyName,
  viewerRoleLabel,
  openCountLabel,
  yourTurnCount,
  yourTurnLabel,
  menuLabel,
  onWithdraw,
  withdrawLabel,
  onRejectContract,
  rejectLabel,
  onChat,
  chatLabel,
}: ReviewHeaderProps): JSX.Element {
  return (
    <div className={styles.wrap} data-testid="review-header">
      <div className={styles.top}>
        <div>
          <h1 className={styles.title}>{title}</h1>
          <p className={styles.counterparty}>
            {counterpartyName} · <Badge tone="ink">{viewerRoleLabel}</Badge> <Badge tone="amber" dot>{statusLabel}</Badge>
          </p>
        </div>
        {onChat ? (
          <Button variant="secondary" size="sm" onClick={onChat}>
            {chatLabel}
          </Button>
        ) : null}
      </div>

      <div className={styles.counters}>
        <span className={styles.openCount} aria-live="polite" data-testid="open-count">
          {openCountLabel}
        </span>
        {yourTurnCount > 0 && yourTurnLabel ? (
          <Badge tone="amber" dot>
            {yourTurnLabel}
          </Badge>
        ) : null}
      </div>

      {(onWithdraw || onRejectContract) && (
        <div className={styles.menu} role="group" aria-label={menuLabel}>
          {onWithdraw && withdrawLabel ? (
            <Button variant="ghost" size="sm" onClick={onWithdraw} data-testid="review-withdraw">
              {withdrawLabel}
            </Button>
          ) : null}
          {onRejectContract && rejectLabel ? (
            <Button variant="ghost" size="sm" onClick={onRejectContract} data-testid="review-reject-contract">
              {rejectLabel}
            </Button>
          ) : null}
        </div>
      )}
    </div>
  );
}
