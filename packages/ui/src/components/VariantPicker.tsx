import { RadioGroup, type RadioGroupOption } from './RadioGroup';
import styles from './VariantPicker.module.css';

export interface VariantPickerOption {
  id: string;
  /** Уже отформатированное значение «стало» (деньги/дата — форматирует страница). */
  label: string;
  note?: string;
}

export interface VariantPickerProps {
  fromLabel: string;
  fromValue: string;
  variants: VariantPickerOption[];
  /** Выбор варианта = само действие приёма (DEV-10 §2/§4) — без отдельного шага подтверждения. */
  onPick: (variantId: string) => void;
  ariaLabel: string;
  /** Подпись-аффорданс на каждом варианте («Выбрать» — DEV-10 §3). */
  pickLabel: string;
  /** Своя правка/уже закрыта — только просмотр, без действия. */
  disabled?: boolean;
  /** Правка принята — подсвечивает выбранный вариант, остальные не кликабельны. */
  selectedVariantId?: string | null;
}

/**
 * ⭐ Единый компонент выбора варианта (DEV-10 §0/§2) — три точки входа одного протокола:
 * предложение правки, встречная редакция, предодобренная альтернатива. Правка несёт
 * массив вариантов «стало»; приём = касание по одному (radiogroup, §9 доступность).
 */
export function VariantPicker({
  fromLabel,
  fromValue,
  variants,
  onPick,
  ariaLabel,
  pickLabel,
  disabled,
  selectedVariantId,
}: VariantPickerProps): JSX.Element {
  const options: RadioGroupOption[] = variants.map((v) => ({
    value: v.id,
    label: v.label,
    hint: v.note,
    badge: disabled ? undefined : <span className={styles.pick}>{pickLabel}</span>,
  }));

  return (
    <div className={styles.wrap} data-testid="variant-picker">
      <p className={styles.from}>
        <span className={styles.fromLabel}>{fromLabel}</span>
        <span className={styles.fromValue}>{fromValue}</span>
      </p>
      <RadioGroup
        options={options}
        value={selectedVariantId ?? null}
        onChange={onPick}
        ariaLabel={ariaLabel}
        disabled={disabled}
      />
    </div>
  );
}
