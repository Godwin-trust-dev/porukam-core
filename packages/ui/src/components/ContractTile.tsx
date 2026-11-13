import type { KeyboardEvent, ReactNode } from 'react';
import type { ContractCardStatus } from '@porukam/core';
import { ContractStatus } from './ContractStatus';
import { Icon } from './Icon';
import { LtrText } from './LtrText';
import styles from './ContractTile.module.css';

export interface ContractTileProps {
  /** Короткий № сделки. */
  no: string;
  title: string;
  status: ContractCardStatus;
  statusLabel: string;
  /** «Контрагент · моя роль» — одной строкой, как в строке списка. */
  metaLabel?: string;
  /** Готовый узел контрагента (ссылка на его карточку) перед `metaLabel` —
   * веб-слой, у которого есть роутер (`CounterpartyLink`). */
  metaSlot?: ReactNode;
  /** Готовая сумма (formatMoney на стороне страницы). */
  amountLabel: string;
  payLabel?: string;
  /** Терминальные/не состоявшиеся — приглушённая плитка, без драмы (ADR-009). */
  muted?: boolean;
  onOpen: () => void;
}

/**
 * Плитка сделки (DEV-19 §3, эталон №4 блок 1) — карточный вид той же сделки
 * для грида дашборда, где строка во всю ширину оставляла бы пустое поле.
 * В списке сделок (`/contracts`) вид остаётся строкой: там колонка узкая и
 * рядом стоит колонка деталей.
 */
export function ContractTile({
  no,
  title,
  status,
  statusLabel,
  metaLabel,
  metaSlot,
  amountLabel,
  payLabel,
  muted,
  onOpen,
}: ContractTileProps): JSX.Element {
  function onKeyDown(e: KeyboardEvent<HTMLDivElement>): void {
    if (e.target !== e.currentTarget) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onOpen();
    }
  }

  // НЕ `<button>`: в мете живёт собственная ссылка на карточку контрагента
  // (тот же приём, что `ContractListRow`/`NotificationItem`).
  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={title}
      className={`${styles.tile} ${muted ? styles.muted : ''}`}
      onClick={onOpen}
      onKeyDown={onKeyDown}
      data-testid="contract-tile"
      data-status={status}
    >
      <span className={styles.top}>
        <LtrText as="span" className={styles.no}>
          {no}
        </LtrText>
        <ContractStatus status={status} label={statusLabel} />
      </span>
      <h4 className={styles.title}>{title}</h4>
      {metaSlot || metaLabel ? (
        <p className={styles.meta}>
          {metaSlot ? (
            <>
              <span onClick={(e) => e.stopPropagation()}>{metaSlot}</span>
              {metaLabel ? ' · ' : ''}
            </>
          ) : null}
          {metaLabel}
        </p>
      ) : null}
      <span className={styles.bottom}>
        {payLabel ? <span className={styles.pay}>{payLabel}</span> : <span />}
        <LtrText as="span" className={styles.amount}>
          {amountLabel}
        </LtrText>
      </span>
    </div>
  );
}

export interface CreateContractTileProps {
  label: string;
  onCreate: () => void;
}

/** Замыкающая плитка грида «создать договор» (эталон №4 блок 1). */
export function CreateContractTile({ label, onCreate }: CreateContractTileProps): JSX.Element {
  return (
    <button type="button" className={styles.createTile} onClick={onCreate} data-testid="create-contract-tile">
      <Icon name="plus" size={20} />
      {label}
    </button>
  );
}
