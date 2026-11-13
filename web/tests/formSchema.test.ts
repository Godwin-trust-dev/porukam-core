import { describe, expect, it } from 'vitest';
import {
  buildSchemaFormData,
  fieldVisible,
  mapBackendI18nKey,
  schemaComplete,
  schemaI18nName,
  schemaStageAmount,
  valuesFromFormData,
  type FormFieldSpec,
  type FormSchemaDto,
} from '../src/features/contractNew/formSchema';

function f(partial: Partial<FormFieldSpec> & Pick<FormFieldSpec, 'key' | 'type'>): FormFieldSpec {
  return {
    required: false,
    default: null,
    choices: null,
    min_value: null,
    max_value: null,
    condition: null,
    hint_i18n_key: null,
    kv_block: null,
    ...partial,
  };
}

const LOAN: FormSchemaDto = {
  code: 'loan_individuals',
  schema_version: 1,
  sections: [
    { key: 'amount', title_i18n_key: 'contract_forms.loan.section.amount', external_entity: null, fields: [f({ key: 'amount', type: 'decimal', required: true })] },
    {
      key: 'term',
      title_i18n_key: 'contract_forms.loan.section.term',
      external_entity: null,
      fields: [
        f({ key: 'repayment_type', type: 'choice', required: true, choices: ['lump_sum', 'schedule'] }),
        f({ key: 'due_date', type: 'date', required: true, condition: { field: 'repayment_type', in: ['lump_sum'] } }),
        f({ key: 'schedule', type: 'list', required: true, condition: { field: 'repayment_type', in: ['schedule'] } }),
        f({ key: 'total_interest_amount', type: 'decimal', default: 0 }),
        f({ key: 'early_repayment_allowed', type: 'boolean', default: true }),
        f({ key: 'occupants', type: 'list_str' }),
        f({ key: 'floor', type: 'integer' }),
      ],
    },
  ],
};

describe('formSchema helpers (ADR-105)', () => {
  it('schemaI18nName берёт имя схемы из ключа секции (loan ≠ loan_individuals)', () => {
    expect(schemaI18nName(LOAN)).toBe('loan');
    expect(mapBackendI18nKey('contract_forms.loan.section.amount')).toBe('contractNew.schemaForm.loan.section.amount');
  });

  it('условная видимость по condition {field, in}', () => {
    const due = LOAN.sections[1]!.fields[1]!;
    expect(fieldVisible(due, { repayment_type: 'lump_sum' })).toBe(true);
    expect(fieldVisible(due, { repayment_type: 'schedule' })).toBe(false);
    expect(fieldVisible(due, {})).toBe(false);
  });

  it('schemaComplete: обязательные поля считаются только среди видимых', () => {
    expect(schemaComplete(LOAN, { amount: '100', repayment_type: 'lump_sum', due_date: '2026-12-01' })).toBe(true);
    expect(schemaComplete(LOAN, { amount: '100', repayment_type: 'lump_sum' })).toBe(false);
    expect(schemaComplete(LOAN, { amount: '100', repayment_type: 'schedule', schedule: [] })).toBe(false);
    expect(
      schemaComplete(LOAN, { amount: '100', repayment_type: 'schedule', schedule: [{ due_date: '2026-10-01', amount: '50' }] }),
    ).toBe(true);
  });

  it('buildSchemaFormData приводит типы и не шлёт скрытые/пустые поля', () => {
    const fd = buildSchemaFormData(LOAN, {
      amount: '1 000,50'.replace(' ', ''),
      repayment_type: 'lump_sum',
      due_date: '2026-12-01',
      schedule: [{ due_date: '2026-10-01', amount: '50' }],
      total_interest_amount: '',
      early_repayment_allowed: false,
      occupants: 'Иванов И.И., Петров П.П.\nСидоров',
      floor: '12',
    });
    expect(fd).toEqual({
      amount: '1000.50',
      repayment_type: 'lump_sum',
      due_date: '2026-12-01',
      early_repayment_allowed: false,
      occupants: ['Иванов И.И.', 'Петров П.П.', 'Сидоров'],
      floor: 12,
    });
  });

  it('valuesFromFormData: дефолты схемы и обратное приведение списков', () => {
    const v = valuesFromFormData(LOAN, { occupants: ['a', 'b'], schedule: [{ due_date: '2026-10-01', amount: 50 }] });
    expect(v.early_repayment_allowed).toBe(true);
    expect(v.total_interest_amount).toBe('0');
    expect(v.occupants).toBe('a, b');
    expect(v.schedule).toEqual([{ due_date: '2026-10-01', amount: '50' }]);
    expect(v.amount).toBe('');
  });

  it('schemaStageAmount: аренда — плата за период, займ — тело + проценты или сумма графика', () => {
    expect(schemaStageAmount('rent_items', { rent_amount: '500' })).toBe('500.00');
    expect(schemaStageAmount('rent_home', {})).toBeNull();
    expect(schemaStageAmount('loan_individuals', { amount: '1000', total_interest_amount: '120.5' })).toBe('1120.50');
    expect(
      schemaStageAmount('loan_individuals', {
        amount: '1000',
        repayment_type: 'schedule',
        schedule: [{ amount: '600' }, { amount: '600' }],
      }),
    ).toBe('1200.00');
  });
});
