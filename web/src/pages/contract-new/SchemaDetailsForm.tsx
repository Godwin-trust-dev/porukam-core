import { useTranslation } from 'react-i18next';
import { Button, CurrencyField, SelectField, TextArea, TextField, Toggle } from '@porukam/ui';
import { WIZARD_CURRENCIES } from '../../features/contractNew/currencies';
import {
  choiceLabelKey,
  fieldLabelKey,
  fieldVisible,
  mapBackendI18nKey,
  schemaI18nName,
  type FormFieldSpec,
  type FormSchemaDto,
  type ScheduleRow,
  type SchemaValues,
} from '../../features/contractNew/formSchema';
import { PAYMENT_METHOD_LABEL_KEY, WIZARD_PAYMENT_METHODS } from '../../features/contractNew/paymentMethods';
import { PAYMENT_ORDERS, PAYMENT_ORDER_LABEL_KEY } from '../../features/contractNew/paymentOrders';
import styles from './DetailsStepPage.module.css';
import termsStyles from './TermsStepPage.module.css';

export interface SchemaDetailsFormProps {
  schema: FormSchemaDto;
  values: SchemaValues;
  onChange: (key: string, value: SchemaValues[string]) => void;
  currency: string;
  onCurrencyChange: (code: string) => void;
  paymentMethod: string;
  onPaymentMethodChange: (code: string) => void;
  /** ADR-151: порядок оплаты; `null` — не показывать (заём: поле неприменимо,
   * бэк отвечает 400 payment_order_not_applicable). */
  paymentOrder: string | null;
  onPaymentOrderChange: (code: string) => void;
}

/**
 * Рендерер формы существа по схеме бэка (ADR-105): Аренда → вещи / жильё,
 * Займ. Подписи — `contractNew.schemaForm.<схема>.*` (секции и подсказки —
 * по ключам бэка через `mapBackendI18nKey`, поля и варианты — по ключу поля).
 * Денежные поля (`decimal` с `kv_block` K3/деньги) — обычные текстовые поля
 * с `inputMode="decimal"`; валюта у договора одна, выбирается рядом с первым
 * денежным полем. `list`-поля кроме графика займа (инвентарь, счётчики) — не
 * в этой волне, честно не показываются.
 */
export function SchemaDetailsForm({
  schema,
  values,
  onChange,
  currency,
  onCurrencyChange,
  paymentMethod,
  onPaymentMethodChange,
  paymentOrder,
  onPaymentOrderChange,
}: SchemaDetailsFormProps): JSX.Element {
  const { t } = useTranslation();
  const name = schemaI18nName(schema);
  let currencyShown = false;

  function renderField(f: FormFieldSpec): JSX.Element | null {
    if (!fieldVisible(f, values)) return null;
    const label = t(fieldLabelKey(name, f)) + (f.required ? '' : ` (${t('contractNew.schemaForm.optional')})`);
    const hint = f.hint_i18n_key ? t(mapBackendI18nKey(f.hint_i18n_key)) : undefined;
    const v = values[f.key];
    const testId = `sf-${f.key}`;

    switch (f.type) {
      case 'string':
        return <TextField key={f.key} label={label} hint={hint} value={String(v ?? '')} onChange={(e) => onChange(f.key, e.target.value)} data-testid={testId} />;
      case 'text':
        return <TextArea key={f.key} label={label} hint={hint} value={String(v ?? '')} onChange={(e) => onChange(f.key, e.target.value)} data-testid={testId} />;
      case 'list_str':
        return (
          <TextArea
            key={f.key}
            label={label}
            hint={hint ?? t('contractNew.schemaForm.listStrHint')}
            value={String(v ?? '')}
            onChange={(e) => onChange(f.key, e.target.value)}
            data-testid={testId}
          />
        );
      case 'integer':
        return (
          <TextField
            key={f.key}
            label={label}
            hint={hint}
            inputMode="numeric"
            value={String(v ?? '')}
            onChange={(e) => onChange(f.key, e.target.value.replace(/[^\d]/g, ''))}
            data-testid={testId}
          />
        );
      case 'decimal': {
        const field = (
          <TextField
            key={f.key}
            label={label}
            hint={hint}
            inputMode="decimal"
            value={String(v ?? '')}
            onChange={(e) => onChange(f.key, e.target.value)}
            data-testid={testId}
          />
        );
        if (!currencyShown) {
          currencyShown = true;
          return (
            <div key={f.key} className={styles.row2}>
              {field}
              <CurrencyField label={t('contractNew.currencyLabel')} value={currency} options={[...WIZARD_CURRENCIES]} onChange={onCurrencyChange} />
            </div>
          );
        }
        return field;
      }
      case 'date':
        return <TextField key={f.key} label={label} hint={hint} type="date" value={String(v ?? '')} onChange={(e) => onChange(f.key, e.target.value)} data-testid={testId} />;
      case 'choice':
        return (
          <SelectField key={f.key} label={label} hint={hint} value={String(v ?? '')} onChange={(e) => onChange(f.key, e.target.value)} data-testid={testId}>
            <option value="">{t('contractNew.schemaForm.choosePlaceholder')}</option>
            {(f.choices ?? []).map((c) => (
              <option key={c} value={c}>
                {t(choiceLabelKey(name, f, c))}
              </option>
            ))}
          </SelectField>
        );
      case 'boolean':
        return (
          <div key={f.key} className={termsStyles.toggleRow}>
            <span className={termsStyles.toggleLabel}>{t(fieldLabelKey(name, f))}</span>
            <Toggle
              checked={Boolean(v)}
              onChange={(b) => onChange(f.key, b)}
              label={t(fieldLabelKey(name, f))}
              onLabel={t('common.yes')}
              offLabel={t('common.no')}
            />
          </div>
        );
      case 'list':
        if (f.key !== 'schedule') return null;
        return <ScheduleEditor key={f.key} label={label} rows={(v as ScheduleRow[] | undefined) ?? []} onChange={(rows) => onChange(f.key, rows)} />;
      default:
        return null;
    }
  }

  return (
    <>
      {schema.sections.map((s) => {
        const rendered = s.fields.map(renderField).filter(Boolean);
        if (rendered.length === 0) return null;
        return (
          <section key={s.key} className={styles.schemaSection} data-testid={`sf-section-${s.key}`}>
            <h3 className={styles.schemaSectionTitle}>{t(mapBackendI18nKey(s.title_i18n_key))}</h3>
            {rendered}
          </section>
        );
      })}
      <SelectField
        label={t('contractNew.paymentMethodLabel')}
        required
        value={paymentMethod}
        onChange={(e) => onPaymentMethodChange(e.target.value)}
        data-testid="sf-payment-method"
      >
        <option value="">{t('contractNew.schemaForm.choosePlaceholder')}</option>
        {WIZARD_PAYMENT_METHODS.map((code) => (
          <option key={code} value={code}>
            {t(PAYMENT_METHOD_LABEL_KEY[code] ?? '')}
          </option>
        ))}
      </SelectField>
      {paymentOrder !== null ? (
        <SelectField
          label={t('contractNew.paymentOrderLabel')}
          required
          value={paymentOrder}
          onChange={(e) => onPaymentOrderChange(e.target.value)}
          data-testid="sf-payment-order"
        >
          <option value="">{t('contractNew.schemaForm.choosePlaceholder')}</option>
          {PAYMENT_ORDERS.map((code) => (
            <option key={code} value={code}>
              {t(PAYMENT_ORDER_LABEL_KEY[code])}
            </option>
          ))}
        </SelectField>
      ) : null}
    </>
  );
}

function ScheduleEditor({
  label,
  rows,
  onChange,
}: {
  label: string;
  rows: ScheduleRow[];
  onChange: (rows: ScheduleRow[]) => void;
}): JSX.Element {
  const { t } = useTranslation();
  function upd(i: number, patch: Partial<ScheduleRow>): void {
    onChange(rows.map((r, ix) => (ix === i ? { ...r, ...patch } : r)));
  }
  return (
    <div className={styles.schedule} data-testid="sf-schedule">
      <span className={styles.scheduleLabel}>{label}</span>
      {rows.map((r, i) => (
        <div key={i} className={styles.row2}>
          <TextField label={t('contractNew.schemaForm.scheduleDate')} type="date" value={r.due_date} onChange={(e) => upd(i, { due_date: e.target.value })} data-testid={`sf-schedule-date-${i}`} />
          <TextField label={t('contractNew.schemaForm.scheduleAmount')} inputMode="decimal" value={r.amount} onChange={(e) => upd(i, { amount: e.target.value })} data-testid={`sf-schedule-amount-${i}`} />
          <Button variant="ghost" size="sm" onClick={() => onChange(rows.filter((_, ix) => ix !== i))}>
            {t('contractNew.schemaForm.scheduleRemove')}
          </Button>
        </div>
      ))}
      <Button variant="secondary" size="sm" onClick={() => onChange([...rows, { due_date: '', amount: '' }])} data-testid="sf-schedule-add">
        {t('contractNew.schemaForm.scheduleAdd')}
      </Button>
    </div>
  );
}
