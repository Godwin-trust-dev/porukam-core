import type { ReactNode } from 'react';
import { SelectField } from './Field';

export interface CurrencyFieldProps {
  label: string;
  hint?: ReactNode;
  help?: ReactNode;
  helpLabel?: string;
  value: string;
  /** Валюты из юрисдикции/политики — без валюты по умолчанию (ADR-041). */
  options: string[];
  onChange: (currency: string) => void;
  disabled?: boolean;
  id?: string;
}

/**
 * Валюта договора (DEV-09 §3/§6, шаг «Суть») — выбор из списка политики, не свободный ввод.
 * Отдельно от `MoneyField` (сумма+валюта одного поля): здесь валюта одна на весь договор.
 */
export function CurrencyField({ label, hint, help, helpLabel, value, options, onChange, disabled, id }: CurrencyFieldProps): JSX.Element {
  return (
    <SelectField label={label} hint={hint} help={help} helpLabel={helpLabel} id={id} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
      {options.map((c) => (
        <option key={c} value={c}>
          {c}
        </option>
      ))}
    </SelectField>
  );
}
