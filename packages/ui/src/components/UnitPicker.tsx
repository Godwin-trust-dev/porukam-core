import type { UnitOption } from '@porukam/core';
import { Icon } from './Icon';
import { Sheet } from './Sheet';
import styles from './UnitPicker.module.css';

export interface UnitPickerProps {
  open: boolean;
  onClose: () => void;
  value?: string;
  units: UnitOption[];
  onPick: (unit: UnitOption) => void;
  title: string;
  closeLabel: string;
}

/** Окно выбора единицы измерения (DEV-09 §4.3) — с подсказкой-примером у каждой. */
export function UnitPicker({ open, onClose, value, units, onPick, title, closeLabel }: UnitPickerProps): JSX.Element {
  return (
    <Sheet open={open} title={title} onClose={onClose} closeLabel={closeLabel}>
      <ul className={styles.list}>
        {units.map((u) => (
          <li key={u.code}>
            <button
              type="button"
              className={styles.row}
              onClick={() => {
                onPick(u);
                onClose();
              }}
              data-testid={`unit-${u.code}`}
            >
              <span className={styles.label}>{u.label}</span>
              {u.hint ? <span className={styles.hint}>{u.hint}</span> : null}
              {u.code === value ? <Icon name="sealed" size={16} /> : null}
            </button>
          </li>
        ))}
      </ul>
    </Sheet>
  );
}
