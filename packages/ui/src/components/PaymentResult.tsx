import { Badge } from './Badge';
import { Button } from './Button';
import { Icon } from './Icon';
import styles from './PaymentResult.module.css';

export type PaymentResultState = 'succeeded' | 'failed';

export interface PaymentResultProps {
  state: PaymentResultState;
  title: string;
  /** Например «45 000 ₽ · СБП · 14:32» — считает страница. */
  summaryChip?: string;
  errorText?: string;
  doneLabel?: string;
  onDone?: () => void;
  retryLabel?: string;
  onRetry?: () => void;
}

/** Успех/ошибка платежа (DEV-07 §2/§3) — спокойная галочка, БЕЗ искры (искра только для доверия/подписи). */
export function PaymentResult({ state, title, summaryChip, errorText, doneLabel, onDone, retryLabel, onRetry }: PaymentResultProps): JSX.Element {
  return (
    <div className={styles.wrap} data-testid="payment-result" data-state={state}>
      <span className={styles.iconWrap} data-tone={state === 'succeeded' ? 'positive' : 'negative'}>
        <Icon name={state === 'succeeded' ? 'sealed' : 'dispute'} size={32} />
      </span>
      <h2 className={styles.title}>{title}</h2>
      {summaryChip ? <Badge tone="neutral">{summaryChip}</Badge> : null}
      {state === 'failed' && errorText ? <p className={styles.errorText}>{errorText}</p> : null}
      {state === 'failed' && retryLabel && onRetry ? (
        <Button variant="primary" block onClick={onRetry} data-testid="payment-retry">
          {retryLabel}
        </Button>
      ) : null}
      {state === 'succeeded' && doneLabel && onDone ? (
        <Button variant="primary" block onClick={onDone} data-testid="payment-done">
          {doneLabel}
        </Button>
      ) : null}
    </div>
  );
}
