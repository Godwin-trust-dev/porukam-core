import { Icon } from './Icon';
import styles from './StartConditions.module.css';

export type StartConditionState = 'met' | 'na' | 'waiting';

export interface StartConditionItem {
  key: string;
  label: string;
  state: StartConditionState;
  sub?: string;
  /** Есть ссылка → строка кликабельна (§2 ⭐); нет — просто информационная строка. */
  linkRef?: string;
}

export interface StartConditionsProps {
  title: string;
  items: StartConditionItem[];
  stateLabels: Record<StartConditionState, string>;
  openLabel: string;
  onOpen: (linkRef: string) => void;
}

/**
 * «Что нужно для старта» (DEV-11 §2/§3 ⭐) в языке доски B: hairline-строки на
 * одной поверхности, состояние — СЛОВОМ в конце строки («Ждём» / «Готово» /
 * «Не требуется») и цветом слова, у «готово» ещё и галочка — смысл не держится
 * на одном цвете (§7/§8). Строка со ссылкой ведёт в свой раздел: договор,
 * материалы этапа, оплаты.
 */
export function StartConditions({ title, items, stateLabels, openLabel, onOpen }: StartConditionsProps): JSX.Element {
  return (
    <div data-testid="start-conditions">
      <h3 className={styles.title}>{title}</h3>
      <ul className={styles.list}>
        {items.map((it) => {
          const openable = !!it.linkRef;
          const stateClass = it.state === 'met' ? styles.stateMet : it.state === 'waiting' ? styles.stateWaiting : styles.stateNa;
          const body = (
            <>
              <span className={styles.main}>
                <span className={styles.label}>{it.label}</span>
                {it.sub ? <span className={styles.sub}>{it.sub}</span> : null}
              </span>
              <span className={`${styles.state} ${stateClass}`} data-testid="start-condition-state">
                {it.state === 'met' ? <Icon name="verified" size={16} /> : null}
                {stateLabels[it.state]}
              </span>
              {openable ? <Icon name="back" size={16} className={styles.chevron} directional /> : null}
            </>
          );
          return (
            <li key={it.key} className={styles.item} data-state={it.state}>
              {openable ? (
                <button type="button" className={styles.row} onClick={() => onOpen(it.linkRef!)} aria-label={`${it.label} · ${openLabel}`}>
                  {body}
                </button>
              ) : (
                <div className={styles.row}>{body}</div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
