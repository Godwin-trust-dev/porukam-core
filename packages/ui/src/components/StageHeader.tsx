import { Badge, type BadgeTone } from './Badge';
import styles from './StageHeader.module.css';

export interface StageHeaderProps {
  title: string;
  /** «Этап 3 из 5» — считает страница (i18n-интерполяция). */
  indexLabel: string;
  counterparty: string;
  statusLabel: string;
  statusTone: BadgeTone;
  /** «Срок: 12 августа» — уже отформатировано (formatDate). */
  deadlineLabel?: string;
  /** Срок сдвинут из-за приостановки (§4 SuspendedBanner) — рядом с deadlineLabel. */
  shifted?: boolean;
  shiftedLabel?: string;
}

/** Шапка этапа исполнения (DEV-11 §3) — статус текст+цвет (не только цвет, §7 CLAUDE.md). */
export function StageHeader({
  title,
  indexLabel,
  counterparty,
  statusLabel,
  statusTone,
  deadlineLabel,
  shifted,
  shiftedLabel,
}: StageHeaderProps): JSX.Element {
  return (
    <div className={styles.head} data-testid="stage-header">
      <div className={styles.top}>
        <h1 className={styles.title}>{title}</h1>
        <Badge tone={statusTone} dot>
          {statusLabel}
        </Badge>
      </div>
      <div className={styles.meta}>
        <span>{indexLabel}</span>
        <span>{counterparty}</span>
        {deadlineLabel ? (
          <span className={shifted ? styles.shifted : undefined}>
            {deadlineLabel}
            {shifted && shiftedLabel ? ` · ${shiftedLabel}` : ''}
          </span>
        ) : null}
      </div>
    </div>
  );
}
