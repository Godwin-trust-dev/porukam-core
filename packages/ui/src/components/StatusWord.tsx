import type { BadgeTone } from './Badge';
import styles from './StatusWord.module.css';

export interface StatusWordProps {
  /** Уже переведённый текст статуса — страница берёт его из i18n (§12: смысл не только цветом). */
  label: string;
  /** Тон — та же шкала, что у `Badge`/`ContractStatus`: одна карта цветов на весь продукт. */
  tone: BadgeTone;
  className?: string;
}

const TONE_CLASS: Record<BadgeTone, string> = {
  neutral: styles.neutral!,
  green: styles.green!,
  teal: styles.teal!,
  amber: styles.amber!,
  red: styles.red!,
  ink: styles.ink!,
};

/**
 * Статус СЛОВОМ-цветом (DEV-20_2 §2, финал доска A) — второй строкой списка,
 * без подложки и точки. Чип рядом с названием отнимал у него ширину и спорил
 * с суммой справа, поэтому в строке живёт слово, а чип остаётся заголовкам
 * и паспорт-рейлу карточки.
 *
 * Отдельный компонент, а не ветка `ContractStatus`: статусы платежей, споров,
 * заявок и объединений не сводятся к `ContractCardStatus`, но обязаны
 * выглядеть одинаково — общая здесь именно раскраска, а не доменный enum.
 */
export function StatusWord({ label, tone, className }: StatusWordProps): JSX.Element {
  return (
    <span className={`${styles.word} ${TONE_CLASS[tone]} ${className ?? ''}`} data-testid="status-word" data-tone={tone}>
      {label}
    </span>
  );
}
