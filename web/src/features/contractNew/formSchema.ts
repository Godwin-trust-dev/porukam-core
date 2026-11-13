import { useQuery } from '@tanstack/react-query';
import { api } from '../../shared/api';

/**
 * Формы существа по схеме бэка (`GET /contract-types/{code}/form-schema`,
 * `apps.contracts.forms.serialize_schema`) — Аренда → вещи / жильё и Займ
 * (ADR-105). Услуга и Продажа остались ручными формами (ServiceEssence /
 * SaleEssence): у них своя раскладка и побочные сущности (сфера, лист
 * «передача товара»). Здесь — один рендерер на любую схему: секции → поля,
 * типы `string|text|decimal|integer|boolean|date|choice|list_str|list`,
 * условная видимость (`condition: {field, in}`), обязательность.
 *
 * Значения формы хранятся строками (как вводятся) и приводятся к контракту
 * бэка в `buildSchemaFormData`: decimal → строка Decimal, integer → number,
 * boolean → bool, list_str → массив строк (по запятым/строкам), list →
 * массив объектов (график платежей займа: {due_date, amount}).
 */
export type FormFieldType =
  | 'string'
  | 'text'
  | 'decimal'
  | 'integer'
  | 'boolean'
  | 'date'
  | 'choice'
  | 'list_str'
  | 'list';

export interface FormCondition {
  field: string;
  in: string[];
}

export interface FormFieldSpec {
  key: string;
  type: FormFieldType;
  required: boolean;
  default: unknown;
  choices: string[] | null;
  min_value: string | number | null;
  max_value: string | number | null;
  condition: FormCondition | null;
  hint_i18n_key: string | null;
  kv_block: string | null;
}

export interface FormSectionSpec {
  key: string;
  title_i18n_key: string;
  external_entity: string | null;
  fields: FormFieldSpec[];
}

export interface FormSchemaDto {
  code: string;
  schema_version: number;
  sections: FormSectionSpec[];
}

export function useFormSchema(code: string | undefined) {
  return useQuery({
    queryKey: ['contract-type-form-schema', code],
    queryFn: () => api.request<FormSchemaDto>(`/contract-types/${code}/form-schema`),
    enabled: !!code,
    staleTime: 60 * 60 * 1000,
  });
}

/** Строка графика платежей (loan `schedule`) — единственный `list` с полями в этой волне. */
export interface ScheduleRow {
  due_date: string;
  amount: string;
}

export type SchemaValues = Record<string, string | boolean | ScheduleRow[]>;

/**
 * Имя схемы для ключей i18n — второй сегмент `title_i18n_key` секции
 * (`contract_forms.rent_items.section.item` → `rent_items`; у займа бэк
 * именует схему `loan`, а тип — `loan_individuals`).
 */
export function schemaI18nName(schema: FormSchemaDto): string {
  const first = schema.sections[0]?.title_i18n_key ?? '';
  return first.split('.')[1] ?? schema.code;
}

/** `contract_forms.<…>` бэка → `contractNew.schemaForm.<…>` пакета i18n. */
export function mapBackendI18nKey(key: string): string {
  return key.replace(/^contract_forms\./, 'contractNew.schemaForm.');
}

export function fieldLabelKey(schemaName: string, field: FormFieldSpec): string {
  return `contractNew.schemaForm.${schemaName}.field.${field.key}`;
}

export function choiceLabelKey(schemaName: string, field: FormFieldSpec, value: string): string {
  return `contractNew.schemaForm.${schemaName}.choice.${field.key}.${value}`;
}

export function fieldVisible(field: FormFieldSpec, values: SchemaValues): boolean {
  if (!field.condition) return true;
  const v = values[field.condition.field];
  return typeof v === 'string' && field.condition.in.includes(v);
}

function isEmpty(v: string | boolean | ScheduleRow[] | undefined): boolean {
  if (v === undefined) return true;
  if (typeof v === 'boolean') return false;
  if (Array.isArray(v)) return v.length === 0;
  return v.trim() === '';
}

/**
 * Видимые обязательные поля, которые ещё пусты (отсмотр 2026-08-23: «аренда
 * не пропускает, хотя всё заполнено» — «Далее» блокировался молча, человек не
 * видел, ЧЕГО не хватает). Единственный источник и для гейта `schemaComplete`,
 * и для подсказки «Осталось заполнить: …» на странице.
 */
export function missingRequiredFields(schema: FormSchemaDto, values: SchemaValues): FormFieldSpec[] {
  const missing: FormFieldSpec[] = [];
  for (const s of schema.sections) {
    for (const f of s.fields) {
      if (!f.required || !fieldVisible(f, values)) continue;
      if (f.type === 'list' && f.key !== 'schedule') continue; // инвентарь/счётчики — не в этой волне
      if (isEmpty(values[f.key])) {
        missing.push(f);
        continue;
      }
      if (f.type === 'list' && Array.isArray(values[f.key])) {
        const rows = values[f.key] as ScheduleRow[];
        if (rows.some((r) => !r.due_date || !r.amount.trim())) missing.push(f);
      }
    }
  }
  return missing;
}

/** Все видимые обязательные поля заполнены (клиентский гейт «Далее»; истина — 422 бэка). */
export function schemaComplete(schema: FormSchemaDto, values: SchemaValues): boolean {
  return missingRequiredFields(schema, values).length === 0;
}

/** Дефолт поля по схеме: булевы из `default`, прочее — пусто (объект-дефолт
 * займа `interest_type` зависит от суммы — выбирается явно). */
function defaultValue(f: FormFieldSpec): string | boolean | ScheduleRow[] {
  if (f.type === 'boolean') return typeof f.default === 'boolean' ? f.default : false;
  if (f.type === 'list') return [];
  if (f.default !== null && f.default !== undefined && typeof f.default !== 'object') return String(f.default);
  return '';
}

export function valuesFromFormData(schema: FormSchemaDto, fd: Record<string, unknown>): SchemaValues {
  const out: SchemaValues = {};
  for (const s of schema.sections) {
    for (const f of s.fields) {
      const raw = fd[f.key];
      if (raw === undefined || raw === null) {
        out[f.key] = defaultValue(f);
        continue;
      }
      if (f.type === 'boolean') out[f.key] = Boolean(raw);
      else if (f.type === 'list_str') out[f.key] = Array.isArray(raw) ? raw.map(String).join(', ') : String(raw);
      else if (f.type === 'list') {
        out[f.key] = Array.isArray(raw)
          ? raw
              .filter((r): r is Record<string, unknown> => typeof r === 'object' && r !== null)
              .map((r) => ({ due_date: String(r.due_date ?? ''), amount: String(r.amount ?? '') }))
          : [];
      } else out[f.key] = String(raw);
    }
  }
  return out;
}

/** Только видимые поля; пустые необязательные не отправляются. */
export function buildSchemaFormData(schema: FormSchemaDto, values: SchemaValues): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const s of schema.sections) {
    for (const f of s.fields) {
      if (!fieldVisible(f, values)) continue;
      const v = values[f.key];
      if (isEmpty(v)) continue;
      switch (f.type) {
        case 'boolean':
          out[f.key] = Boolean(v);
          break;
        case 'integer': {
          const n = Number.parseInt(String(v), 10);
          if (!Number.isNaN(n)) out[f.key] = n;
          break;
        }
        case 'decimal':
          out[f.key] = String(v).replace(',', '.').trim();
          break;
        case 'list_str':
          out[f.key] = String(v)
            .split(/[,\n;]/)
            .map((x) => x.trim())
            .filter(Boolean);
          break;
        case 'list':
          out[f.key] = (v as ScheduleRow[]).map((r) => ({
            due_date: r.due_date,
            amount: r.amount.replace(',', '.').trim(),
          }));
          break;
        default:
          out[f.key] = String(v);
      }
    }
  }
  return out;
}

/** Сумма единственного листа-этапа для типов без шага «Этапы» (как у продажи):
 * аренда — плата за период, займ — тело + проценты (график суммируется). */
export function schemaStageAmount(code: string, fd: Record<string, unknown>): string | null {
  const dec = (x: unknown): number | null => {
    if (x === undefined || x === null || x === '') return null;
    const n = Number(String(x).replace(',', '.'));
    return Number.isFinite(n) ? n : null;
  };
  if (code.startsWith('rent_')) {
    const n = dec(fd.rent_amount);
    return n === null ? null : n.toFixed(2);
  }
  if (code.startsWith('loan_')) {
    if (fd.repayment_type === 'schedule' && Array.isArray(fd.schedule) && fd.schedule.length > 0) {
      const total = (fd.schedule as Record<string, unknown>[]).reduce((acc, r) => acc + (dec(r.amount) ?? 0), 0);
      return total.toFixed(2);
    }
    const body = dec(fd.amount);
    if (body === null) return null;
    return (body + (dec(fd.total_interest_amount) ?? 0)).toFixed(2);
  }
  return null;
}

/** Есть ли у черновика существо по схеме (гейт отправки на превью). */
export function schemaHasEssence(code: string, fd: Record<string, unknown>): boolean {
  if (code === 'rent_items') return !!fd.item_name;
  if (code === 'rent_home') return !!fd.address;
  if (code.startsWith('loan_')) return !!fd.amount;
  return false;
}
