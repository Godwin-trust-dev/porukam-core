import {
  forwardRef,
  useId,
  useState,
  type InputHTMLAttributes,
  type TextareaHTMLAttributes,
  type SelectHTMLAttributes,
  type ReactNode,
} from 'react';
import { Icon } from './Icon';
import { FieldHelp } from './FieldHelp';
import styles from './Field.module.css';

/** Обёртка селекта (DEV-17 §1): гасим системную стрелку (`appearance:none`)
 * и рисуем свой шеврон поверх — единый V2-вид у ВСЕХ селектов проекта. */
function SelectShell({ children }: { children: ReactNode }): JSX.Element {
  return (
    <span className={styles.selectShell}>
      {children}
      <span className={styles.selectChevron} aria-hidden="true">
        <Icon name="chevron-down" size={16} />
      </span>
    </span>
  );
}

export interface BaseFieldProps {
  label?: string;
  error?: string;
  hint?: ReactNode;
  id?: string;
  /** Обязательное поле: звёздочка у подписи + `required` на контроле (отсмотр 22.08). */
  required?: boolean;
  /** Подсказка «о чём поле и что вписывать» — маленький серый «?» у подписи,
   * по нажатию раскрывает текст под полем (отсмотр 22.08). */
  help?: ReactNode;
  /** Доступное имя кнопки «?» (локализует вызывающая сторона). */
  helpLabel?: string;
}

/** Обвязка поля: подпись со звёздочкой и «?», сам контрол, hint и ошибка.
 * Экспортируется для нестандартных контролов (`SearchSelect`) — чтобы у них
 * была ровно та же строка подписи и то же связывание aria, а не копия. */
export function FieldShell({
  label,
  error,
  hint,
  id,
  required,
  help,
  helpLabel,
  children,
}: BaseFieldProps & {
  children: (fieldId: string, describedBy: string | undefined, invalid: boolean) => ReactNode;
}): JSX.Element {
  const autoId = useId();
  const fieldId = id ?? autoId;
  const errId = `${fieldId}-err`;
  const hintId = `${fieldId}-hint`;
  const [helpTextId, setHelpTextId] = useState<string | null>(null);
  const describedBy =
    [error ? errId : null, hint ? hintId : null, helpTextId].filter(Boolean).join(' ') || undefined;
  return (
    <div className={styles.wrap}>
      {label || help ? (
        <span className={`${styles.labelRow} ${label ? '' : styles.labelRowHelpOnly}`}>
          {label ? (
            <label className={styles.label} htmlFor={fieldId}>
              {label}
              {required ? (
                <span className={styles.required} aria-hidden="true">
                  {' *'}
                </span>
              ) : null}
            </label>
          ) : null}
          {help ? (
            <FieldHelp label={helpLabel} onOpenChange={(open, id2) => setHelpTextId(open ? id2 : null)}>
              {help}
            </FieldHelp>
          ) : null}
        </span>
      ) : null}
      {children(fieldId, describedBy, Boolean(error))}

      {hint ? (
        <span className={styles.hint} id={hintId}>
          {hint}
        </span>
      ) : null}
      {error ? (
        <span className={styles.error} id={errId} role="alert">
          {error}
        </span>
      ) : null}
    </div>
  );
}

export interface TextFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'id'>, BaseFieldProps {}

export const TextField = forwardRef<HTMLInputElement, TextFieldProps>(function TextField(
  { label, error, hint, id, required, help, helpLabel, ...rest },
  ref,
) {
  return (
    <FieldShell label={label} error={error} hint={hint} id={id} required={required} help={help} helpLabel={helpLabel}>
      {(fieldId, describedBy, invalid) => (
        <input
          required={required}
          ref={ref}
          id={fieldId}
          className={`${styles.control} ${invalid ? styles.invalid : ''}`}
          aria-invalid={invalid || undefined}
          aria-describedby={describedBy}
          {...rest}
        />
      )}
    </FieldShell>
  );
});

export interface TextAreaProps extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'id'>, BaseFieldProps {}

export const TextArea = forwardRef<HTMLTextAreaElement, TextAreaProps>(function TextArea(
  { label, error, hint, id, required, help, helpLabel, ...rest },
  ref,
) {
  return (
    <FieldShell label={label} error={error} hint={hint} id={id} required={required} help={help} helpLabel={helpLabel}>
      {(fieldId, describedBy, invalid) => (
        <textarea
          required={required}
          ref={ref}
          id={fieldId}
          className={`${styles.control} ${invalid ? styles.invalid : ''}`}
          aria-invalid={invalid || undefined}
          aria-describedby={describedBy}
          {...rest}
        />
      )}
    </FieldShell>
  );
});

export interface SelectFieldProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'id'>, BaseFieldProps {
  children: ReactNode;
}

export const SelectField = forwardRef<HTMLSelectElement, SelectFieldProps>(function SelectField(
  { label, error, hint, id, children, required, help, helpLabel, ...rest },
  ref,
) {
  return (
    <FieldShell label={label} error={error} hint={hint} id={id} required={required} help={help} helpLabel={helpLabel}>
      {(fieldId, describedBy, invalid) => (
        <SelectShell>
          <select
            required={required}
            ref={ref}
            id={fieldId}
            className={`${styles.control} ${styles.select} ${invalid ? styles.invalid : ''}`}
            aria-invalid={invalid || undefined}
            aria-describedby={describedBy}
            {...rest}
          >
            {children}
          </select>
        </SelectShell>
      )}
    </FieldShell>
  );
});

/** Поле OTP-кода: центрированное, крупный трекинг, inputMode numeric. */
export interface OtpFieldProps extends Omit<TextFieldProps, 'inputMode' | 'type'> {
  length?: number;
}
export const OtpField = forwardRef<HTMLInputElement, OtpFieldProps>(function OtpField(
  { length = 6, className, ...rest },
  ref,
) {
  return (
    <TextField
      ref={ref}
      inputMode="numeric"
      autoComplete="one-time-code"
      maxLength={length}
      className={`${styles.otp} ${className ?? ''}`}
      {...rest}
    />
  );
});

/**
 * Денежное поле: строка-сумма + валюта, БЕЗ валюты по умолчанию (§9.2, ADR-041).
 * Значение — контролируемое {amount, currency}; хранение как в API.
 */
export interface MoneyFieldProps extends BaseFieldProps {
  amount: string;
  currency: string;
  currencies?: string[];
  onAmountChange?: (amount: string) => void;
  onCurrencyChange?: (currency: string) => void;
  disabled?: boolean;
  placeholder?: string;
  /** aria-label суммы, когда `label` не задан (ui не хардкодит копирайт — DEV-16 §1). */
  amountAriaLabel: string;
  currencyAriaLabel: string;
  /** Текст плейсхолдера в пустом `<option>` селектора валюты. */
  currencyPlaceholder: string;
}
export function MoneyField({
  label,
  error,
  hint,
  id,
  amount,
  currency,
  currencies = ['RUB', 'USD', 'EUR'],
  onAmountChange,
  onCurrencyChange,
  disabled,
  placeholder,
  amountAriaLabel,
  currencyAriaLabel,
  currencyPlaceholder,
}: MoneyFieldProps): JSX.Element {
  const autoId = useId();
  const amountId = id ?? autoId;
  return (
    <FieldShell label={label} error={error} hint={hint} id={amountId}>
      {(fieldId, describedBy, invalid) => (
        <div className={styles.money}>
          <input
            id={fieldId}
            className={`${styles.control} ${styles.amount} ${invalid ? styles.invalid : ''}`}
            inputMode="decimal"
            value={amount}
            placeholder={placeholder}
            disabled={disabled}
            aria-invalid={invalid || undefined}
            aria-describedby={describedBy}
            aria-label={label ? undefined : amountAriaLabel}
            onChange={(e) => onAmountChange?.(e.target.value)}
          />
          <span className={styles.currency}>
            <SelectShell>
              <select
                className={`${styles.control} ${styles.select}`}
                value={currency}
                disabled={disabled}
                aria-label={currencyAriaLabel}
                onChange={(e) => onCurrencyChange?.(e.target.value)}
              >
                <option value="" disabled>
                  {currencyPlaceholder}
                </option>
                {currencies.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </SelectShell>
          </span>
        </div>
      )}
    </FieldShell>
  );
}
