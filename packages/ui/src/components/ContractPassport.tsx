import type { ReactNode } from 'react';
import type { ContractCardStatus, MoneyLike } from '@porukam/core';
import { formatMoney } from '@porukam/core';
import { ContractStatus } from './ContractStatus';
import { LtrText } from './LtrText';
import styles from './ContractPassport.module.css';

export interface PassportRow {
  label: string;
  /** Уже готовое к показу значение — компонент ничего не считает и не переводит. */
  value: ReactNode;
  /** Значение-ссылка (сторона → её карточка репутации). Без него — просто текст. */
  onOpen?: () => void;
  /** Доступное имя ссылки, если текст значения сам по себе неоднозначен. */
  openLabel?: string;
}

export interface ContractPassportProps {
  /** № договора. */
  no: string;
  title: string;
  /** Тип договора одной строкой («Услуга с этапами»). */
  subtitle?: string;
  status: ContractCardStatus;
  statusLabel: string;
  /** Стороны, защита платежа, юрисдикция — пары «подпись → значение». */
  rows?: PassportRow[];
  /** Сумма договора. `null` — сумма ещё не задана (черновик без этапов). */
  sum?: MoneyLike | null;
  /** Что показать вместо суммы, когда её ещё нет. Молчать нельзя: пустое
   * место читается как «ноль», а это разные вещи. */
  sumUnsetLabel?: string;
  /** Подпись под суммой («3 из 5 этапов · 80 000 ₽ принято»). */
  sumNote?: string;
  /** Главные действия сделки — 1 primary + вторичные. */
  actions?: ReactNode;
  /**
   * Подложка (DEV-20_2 §7). `ink` — тёмный паспорт-рейл десктопной карточки
   * (эталон compact-десктопа блок 3). `light` — светлая рабочая карточка:
   * на телефоне обзор сделки НЕ тёмная плашка целиком, он живёт в том же
   * светлом языке, что остальные рабочие экраны.
   */
  surface?: 'ink' | 'light';
}

/**
 * Паспорт сделки (DEV-19 §4, эталон №4 блок 3): статус, стороны, защита,
 * сумма, главные действия. На десктопе — липкий левый рейл карточки, на
 * узком экране тот же блок становится верхней шапкой (раскладку задаёт
 * `PassportLayout`, компонент про неё не знает).
 */
export function ContractPassport({
  no,
  title,
  subtitle,
  status,
  statusLabel,
  rows,
  sum,
  sumUnsetLabel,
  sumNote,
  actions,
  surface = 'ink',
}: ContractPassportProps): JSX.Element {
  const light = surface === 'light';
  return (
    <section
      className={`${styles.wrap} ${light ? styles.light : ''}`}
      data-testid="contract-passport"
      data-surface={surface}
      aria-label={title}
    >
      <div className={styles.top}>
        <LtrText as="span" className={styles.no}>
          {no}
        </LtrText>
        <ContractStatus status={status} label={statusLabel} on={light ? 'light' : 'dark'} />
      </div>

      <div className={styles.titleBlock}>
        <h2 className={styles.title}>{title}</h2>
        {subtitle ? <span className={styles.subtitle}>{subtitle}</span> : null}
      </div>

      {rows && rows.length > 0 ? (
        <dl className={styles.rows}>
          {rows.map((r) => (
            <div className={styles.row} key={r.label}>
              <dt className={styles.rowLabel}>{r.label}</dt>
              <dd className={styles.rowValue}>
                {r.onOpen ? (
                  <button type="button" className={styles.rowLink} onClick={r.onOpen} aria-label={r.openLabel}>
                    {r.value}
                  </button>
                ) : (
                  r.value
                )}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}

      {sum || sumUnsetLabel ? (
        <div className={styles.sumBlock}>
          {sum ? (
            <LtrText as="span" className={styles.sum} data-testid="passport-sum">
              {formatMoney(sum)}
            </LtrText>
          ) : (
            <span className={styles.sumUnset} data-testid="passport-sum">
              {sumUnsetLabel}
            </span>
          )}
          {sumNote ? <span className={styles.sumNote}>{sumNote}</span> : null}
        </div>
      ) : null}

      {actions ? <div className={styles.actions}>{actions}</div> : null}
    </section>
  );
}
