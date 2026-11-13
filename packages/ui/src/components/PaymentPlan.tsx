import type { MoneyLike } from '@porukam/core';
import { formatMoney } from '@porukam/core';
import { Badge } from './Badge';
import { LtrText } from './LtrText';
import { Button } from './Button';
import styles from './PaymentPlan.module.css';

/** `due` — можно оплатить сейчас (этап принят, оплаты ещё нет); `later` — этап ещё не дошёл до оплаты (DEV-07 §4). */
export type PaymentPlanRowState = 'paid' | 'due' | 'later';

export interface PaymentPlanRow {
  id: string;
  stage: string;
  note?: string;
  amount: MoneyLike;
  state: PaymentPlanRowState;
}

export interface PaymentPlanProps {
  rows: PaymentPlanRow[];
  paidLabel: string;
  dueLabel: string;
  laterLabel: string;
  /** Кнопка «Оплатить» — только для строк в состоянии `due` (DEV-07 §5). */
  payLabel?: string;
  onPay?: (rowId: string) => void;
}

const STATE_TONE = { paid: 'green', due: 'amber', later: 'neutral' } as const;

/** План расчётов по этапам (DEV-06 §3/§5, DEV-07 §4) — статус «Оплачено»/«К оплате»/«Позже» по листу. */
export function PaymentPlan({ rows, paidLabel, dueLabel, laterLabel, payLabel, onPay }: PaymentPlanProps): JSX.Element {
  const STATE_LABEL = { paid: paidLabel, due: dueLabel, later: laterLabel };
  return (
    // Обёртка-контейнер (DEV-19 §6): от неё считается ширина, по которой блок
    // выбирает вид — карточки или таблица. Вид зависит от места, которое
    // компоненту реально дали, а не от размера монитора.
    <div className={styles.container}>
      <div className={styles.wrap} data-testid="payment-plan">
        {rows.map((r) => (
          <div className={styles.row} key={r.id}>
            <div className={styles.main}>
              <p className={styles.stage}>{r.stage}</p>
              {r.note ? <p className={styles.note}>{r.note}</p> : null}
            </div>
            <LtrText as="span" className={styles.amount}>{formatMoney(r.amount)}</LtrText>
            <span className={styles.state}>
              <Badge tone={STATE_TONE[r.state]} dot>
                {STATE_LABEL[r.state]}
              </Badge>
            </span>
            {/* Ячейка действия рендерится всегда — в табличном виде пустая
                ячейка держит колонку, иначе строки без «Оплатить» съезжают. */}
            <span className={styles.action}>
              {r.state === 'due' && onPay && payLabel ? (
                <Button variant="primary" size="sm" onClick={() => onPay(r.id)} data-testid={`pay-stage-${r.id}`}>
                  {payLabel}
                </Button>
              ) : null}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
