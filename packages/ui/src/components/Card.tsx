import type { HTMLAttributes, ReactNode } from 'react';
import { formatMoney, type ContractSummary, type ContractStatus } from '@porukam/core';
import { Badge, type BadgeTone } from './Badge';
import { LtrText } from './LtrText';
import { Icon } from './Icon';
import styles from './Card.module.css';

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
}

/** Базовая карточка. */
export function Card({ children, className, ...rest }: CardProps): JSX.Element {
  return (
    <div className={`${styles.card} ${className ?? ''}`} {...rest}>
      {children}
    </div>
  );
}

const STATUS_TONE: Record<ContractStatus, BadgeTone> = {
  draft: 'neutral',
  under_negotiation: 'amber',
  pending_signature: 'amber',
  active: 'teal',
  under_acceptance: 'amber',
  completed: 'green',
  disputed: 'red',
  terminated: 'neutral',
};

export interface ContractCardProps {
  contract: ContractSummary;
  statusLabel: string;
  segmentLabel: string;
  roleLabel: string;
  /** Текст защиты платежа (под защитой / без защиты). */
  protectionLabel: string;
  milestonesLabel: string;
  /** Текст таймера приёмки — показывается только для under_acceptance. */
  acceptanceLabel?: string;
  onOpen?: () => void;
}

/**
 * Карточка договора: название, стороны, статусы, сегмент, сумма (общий форматтер),
 * защита платежа. Смысл дублируется текстом, не только цветом (§12).
 */
export function ContractCard({
  contract,
  statusLabel,
  segmentLabel,
  roleLabel,
  protectionLabel,
  milestonesLabel,
  acceptanceLabel,
  onOpen,
}: ContractCardProps): JSX.Element {
  const other = contract.parties.find((p) => p.role !== contract.my_role);
  const body = (
    <>
      <div className={styles.head}>
        <h3 className={styles.title}>{contract.title}</h3>
        <Badge tone={STATUS_TONE[contract.status]} dot>
          {statusLabel}
        </Badge>
      </div>
      <p className={styles.parties}>
        {roleLabel}
        {other ? ` · ${other.display_name} (${other.handle})` : ''}
      </p>
      <div className={styles.badges}>
        <Badge tone="ink">{segmentLabel}</Badge>
        <Badge tone="neutral">{contract.sphere}</Badge>
        <Badge tone={contract.payment_protected ? 'teal' : 'neutral'}>{protectionLabel}</Badge>
      </div>
      <div className={styles.footer}>
        <LtrText as="span" className={styles.total}>{formatMoney(contract.total)}</LtrText>
        <span className={styles.meta}>
          {acceptanceLabel ? (
            <span className={styles.acceptance}>
              <Icon name="in-progress" size={16} />
              {acceptanceLabel}
            </span>
          ) : (
            milestonesLabel
          )}
        </span>
      </div>
    </>
  );

  if (onOpen) {
    return (
      <button type="button" className={`${styles.card} ${styles.interactive} ${styles.contract}`} onClick={onOpen}>
        {body}
      </button>
    );
  }
  return <div className={`${styles.card} ${styles.contract}`}>{body}</div>;
}
