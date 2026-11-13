import type { FormEvent, ReactNode } from 'react';
import { Icon } from './Icon';
import styles from './Chat.module.css';

export interface ChatLogProps {
  children: ReactNode;
  ariaLabel?: string;
  className?: string;
  'data-testid'?: string;
}

/** Лента переписки: пузыри и системные плашки в одном потоке, снизу — композер. */
export function ChatLog({ children, ariaLabel, className, ...rest }: ChatLogProps): JSX.Element {
  return (
    <div className={`${styles.log} ${className ?? ''}`} aria-label={ariaLabel} {...rest}>
      {children}
    </div>
  );
}

export interface ChatBubbleProps {
  /** `out` — своё сообщение (янтарь, справа), `in` — собеседника (белый, слева). */
  direction: 'in' | 'out';
  children: ReactNode;
  timeLabel: string;
  /** Точное время — подсказкой, как в ленте уведомлений. */
  exactTimeLabel?: string;
}

/** Пузырь сообщения (DEV-20 §5). Своё — янтарное, чужое — белое с hairline. */
export function ChatBubble({ direction, children, timeLabel, exactTimeLabel }: ChatBubbleProps): JSX.Element {
  return (
    <div
      className={`${styles.bubble} ${direction === 'out' ? styles.out : styles.in}`}
      data-direction={direction}
      data-testid="chat-bubble"
    >
      <p className={styles.body}>{children}</p>
      <span className={styles.time} title={exactTimeLabel}>
        {timeLabel}
      </span>
    </div>
  );
}

export interface ChatSystemEventProps {
  children: ReactNode;
  /** Время события — рядом с текстом, той же плашкой. */
  timeLabel?: string;
}

/**
 * Событие сделки системной плашкой в ленте (DEV-20 §5): «Этап отправлен на
 * приёмку · 40 000 ₽». Не пузырь — у события нет автора-стороны, оно факт
 * договора; отсюда центрированная нейтральная плашка.
 */
export function ChatSystemEvent({ children, timeLabel }: ChatSystemEventProps): JSX.Element {
  return (
    <div className={styles.system} data-testid="chat-system-event">
      <span className={styles.systemText}>{children}</span>
      {timeLabel ? <span className={styles.systemTime}>{timeLabel}</span> : null}
    </div>
  );
}

/** Разделитель дня («Сегодня»). */
export function ChatDay({ children }: { children: ReactNode }): JSX.Element {
  return (
    <div className={styles.day}>
      <span className={styles.dayChip}>{children}</span>
    </div>
  );
}

export interface ChatComposerProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  placeholder: string;
  /** a11y-имя поля: видимой подписи у композера нет по макету. */
  inputLabel: string;
  sendLabel: string;
  sending?: boolean;
  disabled?: boolean;
  'data-testid'?: string;
}

/**
 * Композер снизу (DEV-20 §3/§5): в чате низ экрана действительно занят вводом
 * — это единственное место, где нижняя панель оправдана. Enter отправляет,
 * Shift+Enter переносит строку.
 */
export function ChatComposer({
  value,
  onChange,
  onSubmit,
  placeholder,
  inputLabel,
  sendLabel,
  sending,
  disabled,
  ...rest
}: ChatComposerProps): JSX.Element {
  function submit(e: FormEvent): void {
    e.preventDefault();
    if (!value.trim() || sending || disabled) return;
    onSubmit();
  }
  return (
    <form className={styles.composer} onSubmit={submit}>
      <input
        className={styles.input}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={inputLabel}
        disabled={disabled}
        {...rest}
      />
      <button
        type="submit"
        className={styles.send}
        aria-label={sendLabel}
        disabled={!value.trim() || sending || disabled}
      >
        <Icon name="send" size={20} directional />
      </button>
    </form>
  );
}
