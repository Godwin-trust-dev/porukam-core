import type { ReactNode } from 'react';
import type { NotificationSeverity } from '@porukam/core';
import { Avatar } from './Avatar';
import { Icon } from './Icon';
import type { IconName } from '../icons/paths';
import { ListRow } from './ListRow';
import { LtrText } from './LtrText';
import styles from './NotificationItem.module.css';

const SEVERITY_ICON_CLASS: Record<NotificationSeverity, string> = {
  normal: styles.iconNormal!,
  due: styles.iconDue!,
  good: styles.iconGood!,
};

export interface NotificationItemProps {
  icon: IconName;
  severity: NotificationSeverity;
  /** Нейтральное имя события — уже отрезолвлено под зрителя бэкендом (§4 ⭐). */
  title: string;
  /** Имя контрагента для аватара-лида (DEV-20 §2). Без него лид — иконка типа события. */
  avatarName?: string;
  avatarSrc?: string;
  /** «Контрагент · Договор» — визуально как ссылка, сам пункт целиком — один тап (§3). */
  metaLabel?: string;
  /** Готовый узел контрагента (ссылка на его карточку) — рисуется ПЕРЕД
   * `metaLabel` (веб-слой, у которого есть роутер: `CounterpartyLink`,
   * бэклог 2026-08-21). Ради него пункт — `role="button"`, а не `<button>`. */
  metaSlot?: ReactNode;
  amountLabel?: string;
  /** Относительное время в списке. */
  timeLabel: string;
  /** Точное время — дублируется в `title`-атрибуте (§9 «относительное + точное»). */
  exactTimeLabel: string;
  unread: boolean;
  unreadAriaLabel: string;
  /** Выбранный пункт master-detail на десктопе (DEV-19 §2) — раскрыт справа. */
  selected?: boolean;
  onOpen: () => void;
}

/**
 * Пункт ленты уведомлений (DEV-14 §3, компакт по DEV-20 §2/§5): аватар-лид
 * контрагента + точка непрочитанного, название события НА ВСЮ ШИРИНУ, во
 * второй строке — «контрагент · договор · время». Слова-действия в строке
 * нет (финал доска A, 03.09): действие несёт сам тап по пункту и колонка
 * деталей на десктопе. Номера договора в строке нет — он виден в карточке. Окраска — по `severity` (`due` → тёплая/янтарная, `good`
 * → зелёная, `normal` → нейтральная, §12 — смысл не только цветом,
 * дублируется текстом/жирностью). Тап по всему пункту → одно действие
 * (отметить прочитанным + перейти по `action.href`, если он есть).
 */
export function NotificationItem({
  icon,
  severity,
  title,
  avatarName,
  avatarSrc,
  metaLabel,
  metaSlot,
  amountLabel,
  timeLabel,
  exactTimeLabel,
  unread,
  unreadAriaLabel,
  selected,
  onOpen,
}: NotificationItemProps): JSX.Element {
  // Аватар — когда у события есть человек. Системное событие человека не
  // имеет, и лидом остаётся иконка типа: подменять её «пустым кружком» —
  // врать, что у события есть автор.
  const lead =
    avatarName || avatarSrc ? (
      <Avatar name={avatarName} src={avatarSrc} />
    ) : (
      <span className={`${styles.iconWrap} ${SEVERITY_ICON_CLASS[severity]}`}>
        <Icon name={icon} size={20} />
      </span>
    );

  return (
    <ListRow
      data-testid="notification-item"
      data-unread={unread}
      ariaLabel={title}
      avatar={lead}
      title={severity === 'due' ? <b className={styles.titleDue}>{title}</b> : title}
      meta={
        <>
          {metaSlot ? (
            <>
              {metaSlot}
              {metaLabel || amountLabel ? ' · ' : ''}
            </>
          ) : null}
          {metaLabel}
          {metaLabel && amountLabel ? ' · ' : ''}
          {amountLabel ? <LtrText as="span">{amountLabel}</LtrText> : null}
        </>
      }
      /* Время — в конце второй строки и не усекается (финал доска A:
         «Аренда квартиры · 4 дня»): усекается договор, а не «когда». */
      metaAside={<span title={exactTimeLabel}>{timeLabel}</span>}
      unread={unread}
      unreadAriaLabel={unreadAriaLabel}
      selected={selected}
      onOpen={onOpen}
    />
  );
}
