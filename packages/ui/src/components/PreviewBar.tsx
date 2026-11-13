import { Icon } from './Icon';
import styles from './PreviewBar.module.css';

export interface PreviewBarProps {
  /** Что человек сейчас видит («Вы смотрите свою карточку как гость»). */
  text: string;
  /** Подпись выхода из режима («Вернуться в профиль»). */
  backLabel: string;
  onBack: () => void;
  /** Позиционирование от страницы (ширина колонки, отступ снизу) — sticky живёт на самой полосе. */
  className?: string;
  /** Отметка для тестов/снимков — по умолчанию `preview-bar`. */
  testId?: string;
}

/**
 * Липкая полоса «вы в режиме предпросмотра» с выходом обратно.
 *
 * Замечание владельца 05.09: со своей карточки «как гость» некуда вернуться —
 * публичная страница идёт ВНЕ оболочки приложения, ни навигации, ни «назад».
 * Полоса одинакова на десктопе и на телефоне (одно решение, а не два) и не
 * перекрывает контент: она в потоке, sticky, а не поверх него.
 */
export function PreviewBar({ text, backLabel, onBack, className, testId = 'preview-bar' }: PreviewBarProps): JSX.Element {
  return (
    <div className={[styles.bar, className].filter(Boolean).join(' ')} role="status" aria-live="polite" data-testid={testId}>
      <span className={styles.text}>
        <Icon name="visible" size={16} className={styles.icon} />
        <span>{text}</span>
      </span>
      <button type="button" className={styles.back} onClick={onBack} data-testid={`${testId}-back`}>
        <Icon name="back" size={16} directional />
        <span>{backLabel}</span>
      </button>
    </div>
  );
}
