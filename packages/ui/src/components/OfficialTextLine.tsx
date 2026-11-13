import styles from './OfficialTextLine.module.css';

export interface OfficialTextLineProps {
  /** «Official text — English» — без слова «канон» (DEV-16b §0/§4 ⭐). */
  prefix: string;
  expanded: boolean;
  showLabel: string;
  hideLabel: string;
  onToggle: () => void;
}

/**
 * Тихая строка «Официальный текст — English · показать» (DEV-16b §3/§4) — второй (после
 * `AutoTranslateBadge`) языковой элемент на разноязычной сделке; на одноязычной не
 * рендерится вовсе. Тач-цель ≥ 44px (§6).
 */
export function OfficialTextLine({ prefix, expanded, showLabel, hideLabel, onToggle }: OfficialTextLineProps): JSX.Element {
  return (
    <button type="button" className={styles.line} onClick={onToggle} aria-expanded={expanded}>
      <span>{prefix}</span>
      <span className={styles.action}>· {expanded ? hideLabel : showLabel}</span>
    </button>
  );
}
