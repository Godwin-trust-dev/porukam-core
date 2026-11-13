import type { ContractCardStatus, MoneyLike } from '@porukam/core';
import { formatMoney } from '@porukam/core';
import { Badge } from './Badge';
import { LtrText } from './LtrText';
import { ContractStatus } from './ContractStatus';
import styles from './ContractHeader.module.css';

export interface ContractHeaderProps {
  title: string;
  no: string;
  /** Контрагент — только кликабельное имя, роль не дублируется (DEV-06 §6/§8). */
  counterparty: { name: string; onOpen: () => void };
  viewerRoleLabel: string;
  status: ContractCardStatus;
  statusLabel: string;
  stageCaption?: string;
  sum: MoneyLike;
  /** Пусто/не задано → чип способа расчёта не рендерится (пустой серый
   * бейдж рядом с суммой был дефектом — отсмотр DEV-17). */
  paymentMethodLabel?: string;
  version?: { short: string; onOpen: () => void };
  versionLabel?: string;
}

/** Шапка карточки договора (DEV-06 §3/§5). */
export function ContractHeader({
  title,
  no,
  counterparty,
  viewerRoleLabel,
  status,
  statusLabel,
  stageCaption,
  sum,
  paymentMethodLabel,
  version,
  versionLabel,
}: ContractHeaderProps): JSX.Element {
  return (
    <div className={styles.wrap} data-testid="contract-header">
      <div className={styles.top}>
        <h1 className={styles.title}>{title}</h1>
        <span className={styles.no}>{no}</span>
      </div>

      <div className={styles.meta}>
        <button type="button" className={styles.counterparty} onClick={counterparty.onOpen} data-testid="counterparty-link">
          {counterparty.name}
        </button>
        <Badge tone="ink">{viewerRoleLabel}</Badge>
      </div>

      <ContractStatus status={status} label={statusLabel} stageCaption={stageCaption} />

      <div className={styles.sumRow}>
        <LtrText as="span" className={styles.sum} data-testid="contract-header-sum">{formatMoney(sum)}</LtrText>
        {paymentMethodLabel ? <Badge tone="neutral">{paymentMethodLabel}</Badge> : null}
        {version ? (
          <button type="button" className={styles.version} onClick={version.onOpen} data-testid="version-link">
            {versionLabel ? `${versionLabel}: ` : ''}
            {version.short}
          </button>
        ) : null}
      </div>
    </div>
  );
}
