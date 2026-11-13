import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { SearchSelect, SelectField, TextArea, TextField } from '@porukam/ui';
import type { FormFieldSpec } from '../contractNew/formSchema';

/**
 * Поле «Стало» правки — виджет по типу поля договора (ADR-123): выбор из
 * вариантов, «Да/Нет», дата, число, длинный текст или строка. До этого «Стало»
 * было одной текстовой строкой на все случаи: тумблер приходилось менять
 * словом «да», дату — набирать руками, вариант `choice` — угадывать код
 * (`relative_to_gate`), и бэк отвергал значение уже при принятии правки.
 *
 * Значение наружу — всегда строка; приведение к типу API — `coerceRevisionValue`.
 */
export function RevisionValueField({
  label,
  help,
  helpLabel,
  type,
  choices,
  searchable,
  value,
  onChange,
  testId,
  error,
}: {
  label: string;
  /** Подсказка «?» у подписи (отсмотр 22.08). */
  help?: ReactNode;
  helpLabel?: string;
  type: FormFieldSpec['type'];
  choices: { value: string; label: string }[] | null;
  /** Длинный справочник (каталог материалов, ADR-157) — комбобокс с поиском
   * вместо нативного списка, тот же `SearchSelect`, что в «Материалах». */
  searchable?: boolean;
  value: string;
  onChange: (v: string) => void;
  testId?: string;
  /** Полевая ошибка бэка (422 `revision_value_invalid`, `context.errors`). */
  error?: string;
}): JSX.Element {
  const { t } = useTranslation();

  if (type === 'choice' && searchable && choices && choices.length > 0) {
    return (
      <SearchSelect
        label={label}
        help={help}
        helpLabel={helpLabel}
        error={error}
        value={value}
        onChange={onChange}
        options={choices.map((c) => ({ value: c.value, label: c.label }))}
        placeholder={t('contract.revisionValuePlaceholder')}
        noMatchText={t('common.noMatches')}
        data-testid={testId}
      />
    );
  }

  if (type === 'boolean') {
    return (
      <SelectField label={label} help={help} helpLabel={helpLabel} error={error} value={value} onChange={(e) => onChange(e.target.value)} data-testid={testId}>
        <option value="">{t('contract.revisionValuePlaceholder')}</option>
        <option value="true">{t('common.yes')}</option>
        <option value="false">{t('common.no')}</option>
      </SelectField>
    );
  }

  if (type === 'choice' && choices && choices.length > 0) {
    return (
      <SelectField label={label} help={help} helpLabel={helpLabel} error={error} value={value} onChange={(e) => onChange(e.target.value)} data-testid={testId}>
        <option value="">{t('contract.revisionValuePlaceholder')}</option>
        {choices.map((c) => (
          <option key={c.value} value={c.value}>
            {c.label}
          </option>
        ))}
      </SelectField>
    );
  }

  if (type === 'text' || type === 'list' || type === 'list_str') {
    return (
      <TextArea label={label} help={help} helpLabel={helpLabel} error={error} rows={3} value={value} onChange={(e) => onChange(e.target.value)} data-testid={testId} />
    );
  }

  const inputType = type === 'date' ? 'date' : type === 'integer' || type === 'decimal' ? 'number' : 'text';
  return (
    <TextField
      label={label}
      help={help}
      helpLabel={helpLabel}
      error={error}
      type={inputType}
      // Десятичные суммы — строкой с точкой (деньги в API строкой), шаг не целый.
      step={type === 'decimal' ? '0.01' : undefined}
      inputMode={type === 'decimal' ? 'decimal' : type === 'integer' ? 'numeric' : undefined}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      data-testid={testId}
    />
  );
}
