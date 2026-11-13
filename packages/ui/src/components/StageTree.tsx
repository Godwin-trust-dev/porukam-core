import type { MoneyLike, StageStatus } from '@porukam/core';
import { formatMoney } from '@porukam/core';
import { Badge, type BadgeTone } from './Badge';
import { LtrText } from './LtrText';
import { Icon } from './Icon';
import styles from './StageTree.module.css';

export interface StageTreeItem {
  id: string;
  ix: number;
  name: string;
  meta?: string;
  sum: MoneyLike;
  /** Исполнение листа (§6.3) — НЕ задан, пока договор не исполняется
   * (черновик/согласование): тогда чип статуса не рендерится вовсе —
   * пустой серый бейдж без подписи был дефектом (отсмотр DEV-17). */
  status?: StageStatus;
  statusLabel?: string;
}

export interface StageTreeProps {
  stages: StageTreeItem[];
  /** Вход в сдачу/приёмку конкретного листа (DEV-06 §3) — доступность решает страница. */
  onOpen?: (id: string) => void;
  openLabel?: string;
}

const STATUS_TONE: Record<StageStatus, BadgeTone> = {
  waiting_gate: 'neutral',
  // Канон кита (эталон №1): «в работе» — amber; teal — защита/гарантия (DEV-17).
  in_progress: 'amber',
  submitted: 'amber',
  under_acceptance: 'amber',
  accepted: 'green',
  dispute: 'red',
  suspended: 'amber',
  paid: 'green',
};

/** Дерево этапов (DEV-06 §3) — листья исполнения, лестница статусов §6.3. */
export function StageTree({ stages, onOpen, openLabel }: StageTreeProps): JSX.Element {
  return (
    <ol className={styles.list} data-testid="stage-tree">
      {stages.map((s) => {
        const openable = !!onOpen && (s.status === 'in_progress' || s.status === 'under_acceptance' || s.status === 'submitted');
        const body = (
          <>
            <span className={styles.ix}>{s.ix}</span>
            <div className={styles.main}>
              <p className={styles.name}>{s.name}</p>
              {s.meta ? <p className={styles.meta}>{s.meta}</p> : null}
            </div>
            <LtrText as="span" className={styles.sum}>{formatMoney(s.sum)}</LtrText>
            {s.status && s.statusLabel ? (
              <Badge tone={STATUS_TONE[s.status]} dot>
                {s.statusLabel}
              </Badge>
            ) : null}
            {openable ? <Icon name="back" size={16} className={styles.chevron} directional /> : null}
          </>
        );
        return (
          <li key={s.id} className={styles.item} data-status={s.status}>
            {openable ? (
              <button type="button" className={styles.row} onClick={() => onOpen!(s.id)} aria-label={openLabel}>
                {body}
              </button>
            ) : (
              <div className={styles.row}>{body}</div>
            )}
          </li>
        );
      })}
    </ol>
  );
}
