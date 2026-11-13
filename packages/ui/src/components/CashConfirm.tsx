import { Button } from './Button';
import { PartyRow } from './PartyRow';
import styles from './CashConfirm.module.css';

export interface CashConfirmParty {
  name: string;
  confirmed: boolean;
  /** Уже отформатированное время подтверждения (formatDateTime) — только если confirmed. */
  at?: string;
}

export interface CashConfirmProps {
  payer: CashConfirmParty;
  payee: CashConfirmParty;
  payerLabel: string;
  payeeLabel: string;
  confirmedLabel: string;
  waitingLabel: string;
  /** Показываем кнопку подтверждения только получателю, пока сам не подтвердил (DEV-07 §3). */
  viewerIsPayee: boolean;
  confirmLabel: string;
  onConfirm: () => void;
  /** «Что-то не так?» / «Не получили?» — ведёт в спор, не отменяет отметку (ADR-019/020). */
  disputeLabel: string;
  onDispute: () => void;
}

/**
 * Наличные — двустороннее подтверждение (DEV-07 §2/§3). Отметки необратимы:
 * кнопки «Отменить» нет нигде; расхождение решается спором, не откатом.
 */
export function CashConfirm({
  payer,
  payee,
  payerLabel,
  payeeLabel,
  confirmedLabel,
  waitingLabel,
  viewerIsPayee,
  confirmLabel,
  onConfirm,
  disputeLabel,
  onDispute,
}: CashConfirmProps): JSX.Element {
  return (
    <div className={styles.wrap} data-testid="cash-confirm">
      <PartyRow
        name={payer.name}
        role={payerLabel}
        signState={payer.confirmed ? 'signed' : 'pending'}
        signedAt={payer.at}
        signedLabel={confirmedLabel}
        pendingLabel={waitingLabel}
      />
      <PartyRow
        name={payee.name}
        role={payeeLabel}
        signState={payee.confirmed ? 'signed' : 'pending'}
        signedAt={payee.at}
        signedLabel={confirmedLabel}
        pendingLabel={waitingLabel}
      />

      {viewerIsPayee && !payee.confirmed ? (
        <Button variant="primary" block onClick={onConfirm} data-testid="confirm-receipt">
          {confirmLabel}
        </Button>
      ) : null}

      <button type="button" className={styles.disputeLink} onClick={onDispute} data-testid="dispute-link">
        {disputeLabel}
      </button>
    </div>
  );
}
