import { Badge } from './Badge';
import styles from './AiSummaryCard.module.css';

export interface AiSummaryCardItem {
  label: string;
  value: string;
}

export interface AiSummaryCardProps {
  badgeLabel: string;
  title: string;
  items: AiSummaryCardItem[];
  fullTextLabel: string;
  /** Переход к полному тексту договора — маршрут ведёт страница (react-router), не компонент. */
  onFullText: () => void;
  disclaimer: string;
}

/**
 * «Проверьте перед подписанием» (DEV-05 §2) — одинаковый у обеих сторон.
 * Цена — прямо в списке (отдельного блока «Стоимость» нет, §3).
 */
export function AiSummaryCard({ badgeLabel, title, items, fullTextLabel, onFullText, disclaimer }: AiSummaryCardProps): JSX.Element {
  return (
    <div className={styles.card}>
      <div className={styles.head}>
        <h3 className={styles.title}>{title}</h3>
        <Badge tone="teal">{badgeLabel}</Badge>
      </div>
      <dl className={styles.list}>
        {items.map((it, i) => (
          <div className={styles.row} key={i}>
            <dt className={styles.label}>{it.label}</dt>
            <dd className={styles.value}>{it.value}</dd>
          </div>
        ))}
      </dl>
      <button type="button" className={styles.fullText} onClick={onFullText}>
        {fullTextLabel}
      </button>
      <p className={styles.disclaimer}>{disclaimer}</p>
    </div>
  );
}
