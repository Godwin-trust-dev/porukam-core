import { Icon } from './Icon';
import type { IconName } from '../icons/paths';
import { Badge, type BadgeTone } from './Badge';
import { Button, type ButtonVariant } from './Button';
import { LtrText } from './LtrText';
import styles from './AttentionCard.module.css';

export type AttentionSide = 'customer' | 'contractor';
export type AttentionUrgencyKind = 'timer' | 'deadline' | 'amount';

export interface AttentionUrgency {
  kind: AttentionUrgencyKind;
  /** Уже отформатированное значение (formatCountdown/formatMoney — считает страница). */
  value: string;
}

export interface AttentionAction {
  label: string;
  /**
   * Короткая подпись для телефона (замечание владельца 06.09): «Открыть приёмку»
   * на 360px не помещается рядом с чипом и счётчиком и наезжает на текст.
   * Задана — на узком экране рисуется она, полная остаётся на десктопе.
   */
  shortLabel?: string;
  variant?: ButtonVariant;
}

/** Второй способ ответа: не действие, а информация — «ждём другую сторону» (DEV-06 §2/§8). */
export interface AttentionInfo {
  text: string;
  note?: string;
  secondaryAction?: { label: string; onAction: () => void };
}

export interface AttentionCardProps {
  side: AttentionSide;
  sideLabel: string;
  /**
   * Чип рода события (compact-десктоп: «● Приёмка» янтарный, «Оплата»
   * бирюзовый). Передан — стоит чипом, а метка стороны уходит в подпись
   * после заголовка; не передан — чипом остаётся сторона (как раньше).
   */
  kindLabel?: string;
  kindTone?: BadgeTone;
  /** Опционально: DEV-06 карточки договора не всегда несут срочность (напр. «ждём приёмку»). */
  urgency?: AttentionUrgency;
  title: string;
  /** Режим «действие в один клик» (DEV-03). Взаимоисключим с `info`. */
  action?: AttentionAction;
  onAction?: () => void;
  /** Режим «информация, действие не у меня» (DEV-06 §2) — симметрия: то же событие, чужая роль. */
  info?: AttentionInfo;
  /** Дополнительные короткие факты под основным блоком (DEV-06 §3 AttentionCard `more`). */
  more?: { text: string }[];
  /**
   * Короткий заголовок для телефона (замечание владельца 09.09): на десктопе
   * в строке стоит целая фраза («Кухня — ждёт приёмки»), на 360px она не
   * помещается, а чип рода («Приёмка») ту же мысль уже сказал — на телефоне
   * рисуем ОДНО название. Задан — на узком экране вместо `title` идёт он;
   * не задан — на телефоне остаётся `title` (карточка договора).
   */
  shortTitle?: string;
}

const URGENCY_ICON: Record<AttentionUrgencyKind, IconName> = {
  timer: 'in-progress',
  deadline: 'calendar',
  amount: 'wallet',
};

/**
 * Карточка «требует внимания сейчас» (DEV-03 §3, расширена в DEV-06 §2/§8): единая по
 * обеим ролям, метка стороны на карточке, янтарный акцент слева (срочно, не паника).
 * Один клик (`action`) — когда действие моё; текст + необязательное вторичное действие
 * (`info`) — когда я жду другую сторону (символично один и тот же `event`, разные слова).
 */
export function AttentionCard({
  side,
  sideLabel,
  kindLabel,
  kindTone = 'amber',
  urgency,
  title,
  shortTitle,
  action,
  onAction,
  info,
  more,
}: AttentionCardProps): JSX.Element {
  // Строкой рисуется только «действие в один клик»; информационный режим и
  // список фактов остаются вертикальной карточкой.
  const stacked = !!info || (more?.length ?? 0) > 0;
  return (
    <div
      className={`${styles.card} ${stacked ? styles.stacked : ''} ${shortTitle && !stacked ? styles.shortTitled : ''}`}
      data-side={side}
    >
      <div className={styles.head}>
        {kindLabel ? (
          <Badge tone={kindTone} size="sm" dot>
            {kindLabel}
          </Badge>
        ) : (
          <Badge tone="ink">{sideLabel}</Badge>
        )}
        {urgency ? (
          <span className={styles.urgency}>
            <Icon name={URGENCY_ICON[urgency.kind]} size={16} />
            <LtrText as="span">{urgency.value}</LtrText>
          </span>
        ) : null}
      </div>
      <p className={styles.title}>
        {shortTitle ? (
          <>
            <span className={styles.titleFull}>{title}</span>
            <span className={styles.titleShort}>{shortTitle}</span>
          </>
        ) : (
          title
        )}
        {/* Разделитель « · » рисует CSS (`.side::before`): на телефоне метка
            стороны скрыта, и точка не должна висеть хвостом после названия. */}
        {kindLabel ? <span className={styles.side}>{sideLabel}</span> : null}
      </p>
      {info ? (
        <div className={styles.info}>
          <p className={styles.infoText}>{info.text}</p>
          {info.note ? <p className={styles.infoNote}>{info.note}</p> : null}
          {info.secondaryAction ? (
            <Button variant="ghost" size="sm" onClick={info.secondaryAction.onAction}>
              {info.secondaryAction.label}
            </Button>
          ) : null}
        </div>
      ) : action ? (
        /* Compact-десктоп п.1 / замечание 03.09: кнопка строки — маленькая
           белая с рамкой («Открыть», «Проверить»), не янтарная на пол-строки. */
        <Button variant={action.variant ?? 'ghost'} size="sm" onClick={onAction} className={styles.action}>
          {action.shortLabel ? (
            <>
              <span className={styles.labelFull}>{action.label}</span>
              <span className={styles.labelShort}>{action.shortLabel}</span>
            </>
          ) : (
            action.label
          )}
        </Button>
      ) : null}
      {more && more.length > 0 ? (
        <ul className={styles.more}>
          {more.map((m, i) => (
            <li key={i}>{m.text}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
