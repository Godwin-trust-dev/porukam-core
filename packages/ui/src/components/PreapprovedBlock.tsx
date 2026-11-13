import { Card } from './Card';
import { VariantPicker, type VariantPickerOption } from './VariantPicker';
import styles from './PreapprovedBlock.module.css';

export interface PreapprovedBlockItem {
  id: string;
  itemLabel: string;
  ariaLabel: string;
  fromLabel: string;
  fromValue: string;
  variants: VariantPickerOption[];
}

export interface PreapprovedBlockProps {
  title: string;
  items: PreapprovedBlockItem[];
  pickLabel: string;
  onApply: (altId: string, variantId: string) => void;
}

/** Альтернативы автора (DEV-10 §2/§4) — те же `variants`, приём в 1 клик, без новой итерации. */
export function PreapprovedBlock({ title, items, pickLabel, onApply }: PreapprovedBlockProps): JSX.Element | null {
  if (items.length === 0) return null;
  return (
    <Card data-testid="preapproved-block">
      <h3 className={styles.title}>{title}</h3>
      <div className={styles.list}>
        {items.map((a) => (
          <div className={styles.item} key={a.id}>
            <p className={styles.itemLabel}>{a.itemLabel}</p>
            <VariantPicker
              fromLabel={a.fromLabel}
              fromValue={a.fromValue}
              variants={a.variants}
              ariaLabel={a.ariaLabel}
              pickLabel={pickLabel}
              onPick={(variantId) => onApply(a.id, variantId)}
            />
          </div>
        ))}
      </div>
    </Card>
  );
}
