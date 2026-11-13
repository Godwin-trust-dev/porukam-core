import { formatMoney, type MoneyLike } from '@porukam/core';
import { Badge } from './Badge';
import { Icon } from './Icon';
import { LtrText } from './LtrText';
import styles from './StageRow.module.css';

export interface StageRowProps {
  title: string;
  /** '' — сумма ещё не задана (пустая «стоимость работ»), показываем плейсхолдер. */
  amount: MoneyLike | null;
  auto: boolean;
  durationDays?: string;
  onOpen: () => void;
  /** Не передан — этап нельзя удалить (кнопка скрыта). */
  onDelete?: () => void;
  /** Копировать этап (название, сумма, чек-лист) — новый этап сразу под этим. */
  onCopy?: () => void;
  emptyAmountHint: string;
  autoLabel: string;
  deleteAria: string;
  copyAria?: string;
  untitledLabel: string;
  /** Шаблон с `{{days}}` — вызывающий сам подставляет (i18next-интерполяция). */
  formatDuration: (days: string) => string;
}

/** Строка этапа конструктора «Этапы» (DEV-09 §4.1/§4.2). */
export function StageRow({
  title,
  amount,
  auto,
  durationDays,
  onOpen,
  onDelete,
  onCopy,
  emptyAmountHint,
  autoLabel,
  deleteAria,
  copyAria,
  untitledLabel,
  formatDuration,
}: StageRowProps): JSX.Element {
  return (
    <div className={styles.row} data-testid="stage-row">
      <Icon name="milestone" size={20} className={styles.icon} />
      <button type="button" className={styles.body} onClick={onOpen} data-testid="stage-open">
        <span className={styles.title}>{title || untitledLabel}</span>
        {durationDays ? <span className={styles.meta}>{formatDuration(durationDays)}</span> : null}
      </button>
      {/* Сумма + «поровну» — одной группой: на узком экране уходят второй
          строкой под название, действия остаются в первой (см. CSS). */}
      <span className={styles.money}>
        <span className={styles.amount}>{amount ? <LtrText as="span">{formatMoney(amount)}</LtrText> : emptyAmountHint}</span>
        {auto ? <Badge tone="teal">{autoLabel}</Badge> : null}
      </span>
      {onCopy ? (
        <button type="button" className={styles.action} onClick={onCopy} aria-label={copyAria ?? ''} data-testid="stage-copy">
          <Icon name="copy" size={16} />
        </button>
      ) : null}
      {onDelete ? (
        <button type="button" className={styles.remove} onClick={onDelete} aria-label={deleteAria} data-testid="stage-remove">
          <Icon name="close" size={16} />
        </button>
      ) : null}
    </div>
  );
}
