import type { KeyboardEvent, ReactNode } from 'react';
import { Avatar } from './Avatar';
import { LtrText } from './LtrText';
import styles from './ListRow.module.css';

export interface ListRowProps {
  /** Готовый лид (например, ссылка-аватар). Без него лид собирается из `avatar*`. */
  avatar?: ReactNode;
  avatarName?: string;
  avatarHandle?: string;
  avatarSrc?: string;
  /** Строка 1 слева — название на всю ширину (усечение `…`). */
  title: ReactNode;
  /** Строка 1 справа — время (чат) или иной короткий довесок. Статус-чипа здесь НЕТ (DEV-20_2 §2). */
  titleAside?: ReactNode;
  /** Строка 2 слева — «контрагент · роль/этап». */
  meta?: ReactNode;
  /** Строка 2 справа — статус СЛОВОМ-цветом (DEV-20_2 §2), а не чип у названия. */
  status?: ReactNode;
  /** Строка 1 справа — сумма (`tabular-nums`, по правому краю). */
  amount?: string;
  /** Строка 2 справа вместо суммы — бейдж непрочитанного, счётчик и т.п. */
  metaAside?: ReactNode;
  /** Третья строка — редкий довесок (шаг черновика, подсказка). */
  extra?: ReactNode;
  /** Непрочитанное: точка у начала строки (уведомления, чат). */
  unread?: boolean;
  unreadAriaLabel?: string;
  /** Выбранная строка master-detail (DEV-19 §2). */
  selected?: boolean;
  /** Терминальные/не состоявшиеся — приглушённая строка, без драмы (ADR-009). */
  muted?: boolean;
  /**
   * Строка есть, но выбрать её нельзя (контакт без @хендла — договор с ним не
   * заключить). Приглушена цветом `--pr-text-mute`, без hover и курсора-руки,
   * `aria-disabled` — и клик/Enter по ней ничего не делают. НЕ прячем:
   * человек ищет в списке того, кого помнит, и должен понять, почему его
   * нельзя выбрать (решение владельца 05.09 «приглушай, но не прячь»).
   */
  disabled?: boolean;
  /** Свои интерактивные элементы справа («⋯»); обязаны гасить всплытие клика. */
  trailing?: ReactNode;
  onOpen: () => void;
  ariaLabel?: string;
  className?: string;
  'data-testid'?: string;
  'data-status'?: string;
}

/**
 * Строка списка (DEV-20 §2, ритм v2 — DEV-20_2 §2) — ключевой компонент
 * компакт-раскладки. Один и тот же ритм у сделок, уведомлений, чата и этапов:
 * аватар-лид, две строки — **название на всю ширину + сумма справа**, ниже
 * «контрагент · роль/этап» + **статус словом-цветом**. Hairline от соседей
 * даёт `Surface`, а не собственная рамка строки.
 *
 * Чего в строке НЕТ (§2): статус-чипа у названия (он отнимал у названия
 * ширину и спорил с суммой), номера договора (виден в карточке) и «⋯»
 * (действия — свайп/долгий тап, `SwipeActions`).
 *
 * Открытие — клик по всей строке. Это `role="button"`, а не `<button>`:
 * внутри живут собственные интерактивные элементы (ссылка на контрагента),
 * а HTML запрещает вложенные интерактивные элементы.
 */
export function ListRow({
  avatar,
  avatarName,
  avatarHandle,
  avatarSrc,
  title,
  titleAside,
  meta,
  status,
  amount,
  metaAside,
  extra,
  unread,
  unreadAriaLabel,
  selected,
  muted,
  disabled,
  trailing,
  onOpen,
  ariaLabel,
  className,
  ...rest
}: ListRowProps): JSX.Element {
  function onKeyDown(e: KeyboardEvent<HTMLDivElement>): void {
    if (disabled) return;
    if (e.target !== e.currentTarget) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onOpen();
    }
  }

  const lead =
    avatar ?? <Avatar name={avatarName} handle={avatarHandle} src={avatarSrc} />;

  const cls = [
    styles.row,
    muted ? styles.muted : '',
    disabled ? styles.disabled : '',
    selected ? styles.selected : '',
    unread ? styles.unread : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div
      className={cls}
      role="button"
      tabIndex={0}
      aria-label={ariaLabel}
      aria-current={selected ? 'true' : undefined}
      aria-disabled={disabled || undefined}
      data-selected={selected || undefined}
      data-unread={unread || undefined}
      data-disabled={disabled || undefined}
      onClick={disabled ? undefined : onOpen}
      onKeyDown={onKeyDown}
      {...rest}
    >
      {unread ? <span className={styles.dot} aria-hidden="true" /> : null}
      <span className={styles.lead}>{lead}</span>
      <span className={styles.body}>
        <span className={styles.line}>
          <span className={styles.title}>{title}</span>
          {amount ? (
            <LtrText as="span" className={styles.amount}>
              {amount}
            </LtrText>
          ) : null}
          {titleAside ? <span className={styles.titleAside}>{titleAside}</span> : null}
        </span>
        {meta || status || metaAside ? (
          <span className={styles.line}>
            <span className={styles.meta}>{meta}</span>
            {status ? <span className={styles.status}>{status}</span> : null}
            {metaAside ? <span className={styles.metaAside}>{metaAside}</span> : null}
          </span>
        ) : null}
        {extra ? <span className={styles.extra}>{extra}</span> : null}
      </span>
      {trailing ? <span className={styles.trailing}>{trailing}</span> : null}
      {unread && unreadAriaLabel ? <span className={styles.srOnly}>{` (${unreadAriaLabel})`}</span> : null}
    </div>
  );
}
