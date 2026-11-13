import { Button } from './Button';
import { Callout } from './Callout';
import styles from './PayoutGate.module.css';

export interface PayoutGateProps {
  /** Гейт нужен только при онлайн-выплатах без настроенных реквизитов (DEV-07 §3). */
  required: boolean;
  title: string;
  text: string;
  ctaLabel: string;
  onSetup: () => void;
}

/** Гейт реквизитов для получения онлайн-платежей (DEV-07 §3) — не про комиссию, про приём денег. */
export function PayoutGate({ required, title, text, ctaLabel, onSetup }: PayoutGateProps): JSX.Element | null {
  if (!required) return null;
  return (
    <div data-testid="payout-gate">
      <Callout tone="warn" title={title}>
        {text}
        <div className={styles.action}>
          <Button variant="secondary" size="sm" onClick={onSetup} data-testid="payout-gate-setup">
            {ctaLabel}
          </Button>
        </div>
      </Callout>
    </div>
  );
}
