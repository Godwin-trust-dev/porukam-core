import { formatMoney, type MoneyLike } from '@porukam/core';
import { LtrText } from './LtrText';
import styles from './MoneyPanel.module.css';

export type MoneyPanelRole = 'customer' | 'contractor';

export interface MoneyPanelProps {
  role: MoneyPanelRole;
  /** Заработано (contractor) / потрачено (customer) — подпись задаёт страница. Опционально (DEV-06 §3: не нужно на карточке договора). */
  earnedLabel?: string;
  earned?: MoneyLike;
  /** % выполнения по этапам — опционально (DEV-06: только % оплаты нужен на карточке договора). */
  donePct?: number;
  donePctLabel?: string;
  paidPct: number;
  paidPctLabel: string;
  /** Получено (contractor) / оплачено (customer) — «Оплачено» универсально на карточке договора (DEV-06 §11.5). */
  receivedLabel: string;
  received: MoneyLike;
  /** Ожидается (contractor) / к оплате (customer) — «Остаток» универсально на карточке договора. */
  expectedLabel: string;
  expected: MoneyLike;
  /** Способ расчёта — плитка карточки договора (DEV-06 §3 MoneyPanel `method`), опционально. */
  methodLabel?: string;
  method?: string;
}

/**
 * Денежный блок (DEV-03 §3 дашборд + DEV-06 §3/§5 карточка договора, универс.):
 * опциональные «Заработано/Потрачено» и «% выполнения» — для дашборда; обязательны
 * только % оплаты и «Оплачено»/«Остаток» (карточка договора — универсальные подписи,
 * не «Получено/Ожидается»); опциональный способ расчёта. Без холда — эскроу в MVP нет.
 */
export function MoneyPanel({
  role,
  earnedLabel,
  earned,
  donePct,
  donePctLabel,
  paidPct,
  paidPctLabel,
  receivedLabel,
  received,
  expectedLabel,
  expected,
  methodLabel,
  method,
}: MoneyPanelProps): JSX.Element {
  return (
    <div className={styles.panel} data-role={role}>
      {earnedLabel && earned ? (
        <div className={styles.headline}>
          <span className={styles.headlineLabel}>{earnedLabel}</span>
          <LtrText as="span" className={styles.headlineAmount}>{formatMoney(earned)}</LtrText>
        </div>
      ) : null}

      <div className={styles.pctRow}>
        {donePct != null && donePctLabel ? (
          <div className={styles.pctCell}>
            <span className={styles.pctValue}>{donePct}%</span>
            <span className={styles.pctLabel}>{donePctLabel}</span>
          </div>
        ) : null}
        <div className={styles.pctCell}>
          <span className={styles.pctValue}>{paidPct}%</span>
          <span className={styles.pctLabel}>{paidPctLabel}</span>
        </div>
      </div>

      <div className={styles.footer}>
        <div className={styles.footerCell}>
          <span className={styles.footerLabel}>{receivedLabel}</span>
          <LtrText as="span" className={styles.footerAmount}>{formatMoney(received)}</LtrText>
        </div>
        <div className={styles.footerCell}>
          <span className={styles.footerLabel}>{expectedLabel}</span>
          <LtrText as="span" className={styles.footerAmount}>{formatMoney(expected)}</LtrText>
        </div>
        {methodLabel && method ? (
          <div className={styles.footerCell}>
            <span className={styles.footerLabel}>{methodLabel}</span>
            <span className={styles.footerAmount}>{method}</span>
          </div>
        ) : null}
      </div>
    </div>
  );
}
