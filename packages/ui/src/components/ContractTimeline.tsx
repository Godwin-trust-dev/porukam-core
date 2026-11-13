import { Icon } from './Icon';
import styles from './ContractTimeline.module.css';

export interface ContractTimelineItem {
  id: string;
  title: string;
  /** Уже отформатированное время (formatDateTime — считает страница). */
  at: string;
  who?: string;
  /** Короткое пояснение под подписью (ADR-134: `detail` события хроники —
   * причина отклонения, срок приёмки; либо код события, когда подписи нет). */
  detail?: string;
  done: boolean;
}

export interface ContractTimelineProps {
  events: ContractTimelineItem[];
}

/** Лента событий договора (DEV-06 §3/§5) — история от заключения до текущего момента. */
export function ContractTimeline({ events }: ContractTimelineProps): JSX.Element {
  return (
    <ol className={styles.list} data-testid="contract-timeline">
      {events.map((e) => (
        <li className={styles.item} key={e.id} data-done={e.done}>
          <span className={styles.dot} aria-hidden="true">
            {e.done ? <Icon name="checklist" size={16} /> : null}
          </span>
          <div className={styles.body}>
            <p className={styles.title}>{e.title}</p>
            {e.detail ? <p className={styles.detail}>{e.detail}</p> : null}
            <p className={styles.meta}>
              {e.at}
              {e.who ? ` · ${e.who}` : ''}
            </p>
          </div>
        </li>
      ))}
    </ol>
  );
}
