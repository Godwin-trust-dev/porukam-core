import { Badge, type BadgeTone } from './Badge';
import { EmptyState } from './States';
import styles from './DisputesPanel.module.css';

export interface DisputesPanelItem {
  id: string;
  itemLabel: string;
  statusLabel: string;
  statusTone: BadgeTone;
  turnLabel: string;
}

export interface DisputesPanelProps {
  title: string;
  items: DisputesPanelItem[];
  onOpen: (id: string) => void;
  emptyTitle: string;
}

/** Панель «Разногласия» (desktop, DEV-10 §3/§9) — список открытых с быстрым переходом к правке. */
export function DisputesPanel({ title, items, onOpen, emptyTitle }: DisputesPanelProps): JSX.Element {
  return (
    <div className={styles.wrap} data-testid="disputes-panel">
      <h3 className={styles.title}>{title}</h3>
      {items.length === 0 ? (
        <EmptyState icon="symmetric" title={emptyTitle} />
      ) : (
        <ul className={styles.list}>
          {items.map((it) => (
            <li key={it.id}>
              <button type="button" className={styles.row} onClick={() => onOpen(it.id)}>
                <span className={styles.itemLabel}>{it.itemLabel}</span>
                <span className={styles.badges}>
                  <Badge tone={it.statusTone} dot>
                    {it.statusLabel}
                  </Badge>
                  <span className={styles.turn}>{it.turnLabel}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
