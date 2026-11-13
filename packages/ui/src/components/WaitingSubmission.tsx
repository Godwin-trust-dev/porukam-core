import { Icon } from './Icon';
import { Button } from './Button';
import styles from './WaitingSubmission.module.css';

export interface WaitingSubmissionProps {
  /** Уже отформатированный текст срока («Осталось 2 дня» / «Задержка на 3 дня») — считает страница. */
  scheduleLabel: string;
  /** 'delayed', если срок сдачи прошёл — влияет только на акцент цвета текста, не смысл. */
  tone?: 'planned' | 'delayed';
  chatLabel: string;
  /** Без обработчика кнопка чата не рендерится (чат выключен, отсмотр 22.08). */
  onChat?: () => void;
}

/** Состояние «ожидаем сдачу» (DEV-04 §6): этап ещё не сдан исполнителем. */
export function WaitingSubmission({ scheduleLabel, tone = 'planned', chatLabel, onChat }: WaitingSubmissionProps): JSX.Element {
  return (
    <div className={styles.state} data-tone={tone}>
      <Icon name="calendar" size={48} className={styles.icon} />
      <p className={styles.title}>{scheduleLabel}</p>
      {onChat ? (
        <Button variant="ghost" onClick={onChat}>
          {chatLabel}
        </Button>
      ) : null}
    </div>
  );
}
