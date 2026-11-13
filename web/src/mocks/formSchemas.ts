import type { FormFieldSpec, FormSchemaDto } from '../features/contractNew/formSchema';

/**
 * Мок-схемы форм — зеркало `apps.contracts.forms.serialize_schema(
 * get_form_schema(code))` (GET /contract-types/{code}/form-schema).
 * Нужны реальному контуру: выпадающий список «Что меняем» в правке (ADR-123)
 * строится по видимым полям схемы, «Было» берётся из form_data договора.
 *
 * Схемы услуги/продажи/аренды/займа сняты с бэка один в один (ключи, типы,
 * required, choices, condition, default, min/max, hint, kv_block), чтобы dev
 * на моках совпадал с продом. Раньше схема была только у `services_*`, и на
 * sale/rent/loan список «Что меняем» падал в фолбэк по ключам `form_data`
 * (а `formSchemaHasField` резал любую правку в 422 `revision_item_unknown`) —
 * хвосты 2026-08-25.
 */
const f = (key: string, type: FormFieldSpec['type'], extra: Partial<FormFieldSpec> = {}): FormFieldSpec => ({
  key,
  type,
  required: false,
  default: null,
  choices: null,
  min_value: null,
  max_value: null,
  condition: null,
  hint_i18n_key: null,
  kv_block: null,
  ...extra,
});

export const SERVICE_FORM_SCHEMA: FormSchemaDto = {
  code: 'services',
  schema_version: 1,
  sections: [
    { key: 'sphere', title_i18n_key: 'contract_forms.service.section.sphere', external_entity: null, fields: [f('sphere_code', 'choice', { required: true, choices: ['renovation', 'furniture', 'it', 'other'] })] },
    { key: 'description', title_i18n_key: 'contract_forms.service.section.description', external_entity: null, fields: [f('work_description', 'text', { required: true })] },
    {
      key: 'location',
      title_i18n_key: 'contract_forms.service.section.location',
      external_entity: null,
      fields: [
        f('location_type', 'choice', { required: true, choices: ['onsite', 'remote'] }),
        f('location_address', 'string', { required: true, condition: { field: 'location_type', in: ['onsite'] } }),
      ],
    },
    {
      key: 'term',
      title_i18n_key: 'contract_forms.service.section.term',
      external_entity: null,
      fields: [
        f('term_type', 'choice', { required: true, choices: ['dates', 'relative_to_gate'] }),
        f('start_date', 'date', { required: true, condition: { field: 'term_type', in: ['dates'] } }),
        f('end_date', 'date', { required: true, condition: { field: 'term_type', in: ['dates'] } }),
        f('duration_days', 'integer', { required: true, min_value: '0', condition: { field: 'term_type', in: ['relative_to_gate'] } }),
      ],
    },
    { key: 'milestones', title_i18n_key: 'contract_forms.service.section.milestones', external_entity: 'milestone', fields: [] },
    { key: 'price', title_i18n_key: 'contract_forms.service.section.price', external_entity: null, fields: [f('price_type', 'choice', { required: true, choices: ['fixed', 'estimate'] })] },
    { key: 'warranty', title_i18n_key: 'contract_forms.service.section.warranty', external_entity: null, fields: [f('warranty_period_days', 'integer', { default: 14, min_value: '0' })] },
    { key: 'acceptance', title_i18n_key: 'contract_forms.service.section.acceptance', external_entity: null, fields: [f('acceptance_window_hours', 'integer', { default: 72, min_value: '1' })] },
    {
      key: 'modules',
      title_i18n_key: 'contract_forms.service.section.modules',
      external_entity: null,
      fields: [
        f('access_required', 'boolean', { default: false }),
        f('subcontract_policy', 'choice', { default: 'forbidden', choices: ['forbidden', 'allowed', 'with_consent'] }),
        f('portfolio_visible', 'boolean', { default: true }),
      ],
    },
  ],
};

/** Схема «Продажа (личная)» — зеркало `get_form_schema("sale_personal")`.
 * Отличие от `sale_business` — секция `household_plot` (отметка о ЛПХ). */
export const SALE_PERSONAL_FORM_SCHEMA: FormSchemaDto = {
  code: 'sale_personal',
  schema_version: 1,
  sections: [
    {
      key: 'category',
      title_i18n_key: 'contract_forms.sale.section.category',
      external_entity: null,
      fields: [
        f('category_code', 'choice', { required: true, choices: ['electronics', 'clothing_footwear', 'furniture_interior', 'appliances', 'hobby_sport', 'books_media', 'kids', 'beauty_health', 'garden_tools', 'food', 'pets', 'auto_parts', 'building_materials', 'household', 'jewelry_watches', 'handmade_collectibles', 'business_equipment', 'other'], kv_block: 'V-GOODS' }),
      ],
    },
    {
      key: 'item',
      title_i18n_key: 'contract_forms.sale.section.item',
      external_entity: null,
      fields: [
        f('item_name', 'string', { required: true, kv_block: 'V-GOODS' }),
        f('item_description', 'text', { required: true, kv_block: 'V-GOODS' }),
        f('condition', 'choice', { required: true, choices: ['new', 'used'], kv_block: 'V-GOODS' }),
        f('condition_defects_description', 'text', { required: true, condition: { field: 'condition', in: ['used'] }, kv_block: 'V-GOODS' }),
        f('completeness', 'text', { kv_block: 'V-GOODS' }),
        f('identifiers', 'string', { required: true, condition: { field: 'category_code', in: ['electronics'] }, hint_i18n_key: 'contract_forms.sale.identifiers.hint', kv_block: 'V-GOODS' }),
        f('photos', 'list_str', { kv_block: 'V-GOODS' }),
      ],
    },
    {
      key: 'household_plot',
      title_i18n_key: 'contract_forms.sale.section.household_plot',
      external_entity: null,
      fields: [
        f('own_household_plot', 'boolean', { default: false, hint_i18n_key: 'contract_forms.sale.household_plot.hint', kv_block: 'tax_note' }),
      ],
    },
    { key: 'price', title_i18n_key: 'contract_forms.sale.section.price', external_entity: null, fields: [f('price', 'decimal', { required: true, min_value: '0', kv_block: 'K3' })] },
    {
      key: 'delivery',
      title_i18n_key: 'contract_forms.sale.section.delivery',
      external_entity: null,
      fields: [
        f('delivery_type', 'choice', { required: true, choices: ['pickup', 'handoff', 'pvz', 'courier', 'transport_company'], kv_block: 'V-HANDOVER' }),
        f('delivery_address', 'string', { required: true, condition: { field: 'delivery_type', in: ['pvz', 'courier', 'transport_company'] }, kv_block: 'V-HANDOVER' }),
        f('delivery_payer', 'choice', { required: true, choices: ['seller', 'buyer', 'split'], condition: { field: 'delivery_type', in: ['pvz', 'courier', 'transport_company'] }, kv_block: 'V-HANDOVER' }),
        f('delivery_deadline_type', 'choice', { required: true, choices: ['date', 'relative_to_payment'], kv_block: 'V-HANDOVER' }),
        f('delivery_date', 'date', { required: true, condition: { field: 'delivery_deadline_type', in: ['date'] }, kv_block: 'V-HANDOVER' }),
        f('delivery_days', 'integer', { required: true, min_value: '0', condition: { field: 'delivery_deadline_type', in: ['relative_to_payment'] }, kv_block: 'V-HANDOVER' }),
        f('tracking_number', 'string', { condition: { field: 'delivery_type', in: ['transport_company'] }, kv_block: 'V-HANDOVER' }),
      ],
    },
    {
      key: 'inspection',
      title_i18n_key: 'contract_forms.sale.section.inspection',
      external_entity: null,
      fields: [
        f('inspection_window_hours', 'integer', { default: 24, min_value: '1', kv_block: 'V-HANDOVER' }),
      ],
    },
  ],
};

/** Схема «Продажа (бизнес)» — то же, что личная, без секции ЛПХ. */
export const SALE_BUSINESS_FORM_SCHEMA: FormSchemaDto = {
  code: 'sale_business',
  schema_version: 1,
  sections: [
    {
      key: 'category',
      title_i18n_key: 'contract_forms.sale.section.category',
      external_entity: null,
      fields: [
        f('category_code', 'choice', { required: true, choices: ['electronics', 'clothing_footwear', 'furniture_interior', 'appliances', 'hobby_sport', 'books_media', 'kids', 'beauty_health', 'garden_tools', 'food', 'pets', 'auto_parts', 'building_materials', 'household', 'jewelry_watches', 'handmade_collectibles', 'business_equipment', 'other'], kv_block: 'V-GOODS' }),
      ],
    },
    {
      key: 'item',
      title_i18n_key: 'contract_forms.sale.section.item',
      external_entity: null,
      fields: [
        f('item_name', 'string', { required: true, kv_block: 'V-GOODS' }),
        f('item_description', 'text', { required: true, kv_block: 'V-GOODS' }),
        f('condition', 'choice', { required: true, choices: ['new', 'used'], kv_block: 'V-GOODS' }),
        f('condition_defects_description', 'text', { required: true, condition: { field: 'condition', in: ['used'] }, kv_block: 'V-GOODS' }),
        f('completeness', 'text', { kv_block: 'V-GOODS' }),
        f('identifiers', 'string', { required: true, condition: { field: 'category_code', in: ['electronics'] }, hint_i18n_key: 'contract_forms.sale.identifiers.hint', kv_block: 'V-GOODS' }),
        f('photos', 'list_str', { kv_block: 'V-GOODS' }),
      ],
    },
    { key: 'price', title_i18n_key: 'contract_forms.sale.section.price', external_entity: null, fields: [f('price', 'decimal', { required: true, min_value: '0', kv_block: 'K3' })] },
    {
      key: 'delivery',
      title_i18n_key: 'contract_forms.sale.section.delivery',
      external_entity: null,
      fields: [
        f('delivery_type', 'choice', { required: true, choices: ['pickup', 'handoff', 'pvz', 'courier', 'transport_company'], kv_block: 'V-HANDOVER' }),
        f('delivery_address', 'string', { required: true, condition: { field: 'delivery_type', in: ['pvz', 'courier', 'transport_company'] }, kv_block: 'V-HANDOVER' }),
        f('delivery_payer', 'choice', { required: true, choices: ['seller', 'buyer', 'split'], condition: { field: 'delivery_type', in: ['pvz', 'courier', 'transport_company'] }, kv_block: 'V-HANDOVER' }),
        f('delivery_deadline_type', 'choice', { required: true, choices: ['date', 'relative_to_payment'], kv_block: 'V-HANDOVER' }),
        f('delivery_date', 'date', { required: true, condition: { field: 'delivery_deadline_type', in: ['date'] }, kv_block: 'V-HANDOVER' }),
        f('delivery_days', 'integer', { required: true, min_value: '0', condition: { field: 'delivery_deadline_type', in: ['relative_to_payment'] }, kv_block: 'V-HANDOVER' }),
        f('tracking_number', 'string', { condition: { field: 'delivery_type', in: ['transport_company'] }, kv_block: 'V-HANDOVER' }),
      ],
    },
    {
      key: 'inspection',
      title_i18n_key: 'contract_forms.sale.section.inspection',
      external_entity: null,
      fields: [
        f('inspection_window_hours', 'integer', { default: 24, min_value: '1', kv_block: 'V-HANDOVER' }),
      ],
    },
  ],
};

/** Схема «Аренда вещей» — зеркало `get_form_schema("rent_items")`. */
export const RENT_ITEMS_FORM_SCHEMA: FormSchemaDto = {
  code: 'rent_items',
  schema_version: 1,
  sections: [
    {
      key: 'item',
      title_i18n_key: 'contract_forms.rent_items.section.item',
      external_entity: null,
      fields: [
        f('item_name', 'string', { required: true, kv_block: 'V-RENT' }),
        f('item_identification', 'text', { required: true, hint_i18n_key: 'contract_forms.rent_items.identification.hint', kv_block: 'V-RENT' }),
        f('item_description', 'text', { kv_block: 'V-RENT' }),
      ],
    },
    { key: 'value', title_i18n_key: 'contract_forms.rent_items.section.value', external_entity: null, fields: [f('declared_value', 'decimal', { required: true, min_value: '0', kv_block: 'V-INV' })] },
    {
      key: 'term',
      title_i18n_key: 'contract_forms.rent_items.section.term',
      external_entity: null,
      fields: [
        f('term_type', 'choice', { required: true, choices: ['date_range', 'daily'], kv_block: 'K4' }),
        f('start_date', 'date', { required: true, kv_block: 'K4' }),
        f('end_date', 'date', { required: true, condition: { field: 'term_type', in: ['date_range'] }, kv_block: 'K4' }),
      ],
    },
    {
      key: 'payment',
      title_i18n_key: 'contract_forms.rent_items.section.payment',
      external_entity: null,
      fields: [
        f('rent_amount', 'decimal', { required: true, min_value: '0', kv_block: 'K3' }),
        f('rent_period', 'choice', { required: true, choices: ['day', 'week', 'month'], kv_block: 'K3' }),
      ],
    },
    {
      key: 'deposit',
      title_i18n_key: 'contract_forms.rent_items.section.deposit',
      external_entity: null,
      fields: [
        f('deposit_amount', 'decimal', { min_value: '0', kv_block: 'V-RENT' }),
        f('deposit_terms', 'text', { kv_block: 'V-RENT' }),
        f('deposit_non_refundable', 'boolean', { default: false, kv_block: 'V-RENT' }),
      ],
    },
    { key: 'risk', title_i18n_key: 'contract_forms.rent_items.section.risk', external_entity: null, fields: [f('risk_transfer_enabled', 'boolean', { default: true, kv_block: 'V-RENT' })] },
    { key: 'usage', title_i18n_key: 'contract_forms.rent_items.section.usage', external_entity: null, fields: [f('usage_restrictions', 'text', { kv_block: 'V-RENT' })] },
    {
      key: 'handover',
      title_i18n_key: 'contract_forms.rent_items.section.handover',
      external_entity: null,
      fields: [
        f('handover_place', 'string', { required: true, kv_block: 'акт передачи' }),
        f('handover_method', 'text', { kv_block: 'акт передачи' }),
        f('return_place', 'string', { required: true, kv_block: 'акт возврата' }),
        f('return_method', 'text', { kv_block: 'акт возврата' }),
      ],
    },
  ],
};

/** Схема «Аренда жилья» — зеркало `get_form_schema("rent_home")`; версия
 * схемы у неё 2, а не 1 (единственная такая на бэке). */
export const RENT_HOME_FORM_SCHEMA: FormSchemaDto = {
  code: 'rent_home',
  schema_version: 2,
  sections: [
    {
      key: 'object',
      title_i18n_key: 'contract_forms.rent_home.section.object',
      external_entity: null,
      fields: [
        f('address', 'string', { required: true, kv_block: 'V-RENT' }),
        f('object_type', 'choice', { required: true, choices: ['apartment', 'room', 'house'], kv_block: 'V-RENT' }),
        f('floor', 'integer', { min_value: '0', kv_block: 'V-RENT' }),
        f('area_sqm', 'decimal', { min_value: '0', kv_block: 'V-RENT' }),
        f('cadastral_number', 'string', { kv_block: 'V-RENT' }),
      ],
    },
    {
      key: 'disposal_basis',
      title_i18n_key: 'contract_forms.rent_home.section.disposal_basis',
      external_entity: null,
      fields: [
        f('disposal_basis_type', 'choice', { required: true, choices: ['owner', 'attorney', 'sublease_with_consent'], kv_block: 'K1' }),
        f('disposal_basis_document', 'text', { required: true, hint_i18n_key: 'contract_forms.rent_home.disposal_basis_document.hint', kv_block: 'K1' }),
      ],
    },
    {
      key: 'term',
      title_i18n_key: 'contract_forms.rent_home.section.term',
      external_entity: null,
      fields: [
        f('term_kind', 'choice', { default: 'long_term', choices: ['short_term', 'long_term'], kv_block: 'K4' }),
        f('term_days', 'integer', { required: true, min_value: '1', condition: { field: 'term_kind', in: ['short_term'] }, kv_block: 'K4' }),
        f('term_months', 'integer', { default: 11, min_value: '1', condition: { field: 'term_kind', in: ['long_term'] }, kv_block: 'K4' }),
      ],
    },
    {
      key: 'payment',
      title_i18n_key: 'contract_forms.rent_home.section.payment',
      external_entity: null,
      fields: [
        f('rent_amount', 'decimal', { required: true, min_value: '0', kv_block: 'K3' }),
        f('rent_payment_day', 'integer', { required: true, min_value: '1', max_value: '31', kv_block: 'K3' }),
      ],
    },
    {
      key: 'utilities',
      title_i18n_key: 'contract_forms.rent_home.section.utilities',
      external_entity: null,
      fields: [
        f('utilities_mode', 'choice', { required: true, choices: ['included', 'by_meter', 'fixed'], kv_block: 'V-RENT' }),
        f('utilities_fixed_amount', 'decimal', { required: true, min_value: '0', condition: { field: 'utilities_mode', in: ['fixed'] }, kv_block: 'V-RENT' }),
      ],
    },
    {
      key: 'deposit',
      title_i18n_key: 'contract_forms.rent_home.section.deposit',
      external_entity: null,
      fields: [
        f('deposit_amount', 'decimal', { min_value: '0', kv_block: 'V-RENT' }),
        f('deposit_terms', 'text', { kv_block: 'V-RENT' }),
        f('deposit_non_refundable', 'boolean', { default: false, kv_block: 'V-RENT' }),
      ],
    },
    {
      key: 'occupants',
      title_i18n_key: 'contract_forms.rent_home.section.occupants',
      external_entity: null,
      fields: [
        f('occupants', 'list_str', { required: true, kv_block: 'V-RENT' }),
        f('pets_allowed', 'boolean', { default: false, kv_block: 'V-RENT' }),
        f('smoking_allowed', 'boolean', { default: false, kv_block: 'V-RENT' }),
      ],
    },
    { key: 'inventory', title_i18n_key: 'contract_forms.rent_home.section.inventory', external_entity: null, fields: [f('inventory_list', 'list', { kv_block: 'акт заселения' })] },
    { key: 'meters', title_i18n_key: 'contract_forms.rent_home.section.meters', external_entity: null, fields: [f('meter_readings', 'list', { kv_block: 'акт заселения' })] },
  ],
};

/** Схема «Заём между физлицами» — зеркало `get_form_schema("loan_individuals")`.
 * `interest_type.default` — условный дефолт (`ConditionalDefault.as_json()`):
 * при сумме ≤ 100 000 «беспроцентный», выше — «со ставкой» (док 30 §6). */
export const LOAN_FORM_SCHEMA: FormSchemaDto = {
  code: 'loan_individuals',
  schema_version: 1,
  sections: [
    { key: 'amount', title_i18n_key: 'contract_forms.loan.section.amount', external_entity: null, fields: [f('amount', 'decimal', { required: true, min_value: '0', kv_block: 'V-LOAN' })] },
    {
      key: 'interest',
      title_i18n_key: 'contract_forms.loan.section.interest',
      external_entity: null,
      fields: [
        f('interest_type', 'choice', { default: { depends_on: 'amount', threshold: '100000', if_lte: 'interest_free', if_gt: 'rate' }, choices: ['interest_free', 'rate'], kv_block: 'V-LOAN' }),
        f('interest_rate_percent', 'decimal', { required: true, min_value: '0', condition: { field: 'interest_type', in: ['rate'] }, kv_block: 'V-LOAN' }),
      ],
    },
    {
      key: 'term',
      title_i18n_key: 'contract_forms.loan.section.term',
      external_entity: null,
      fields: [
        f('repayment_type', 'choice', { required: true, choices: ['lump_sum', 'schedule'], kv_block: 'K4' }),
        f('due_date', 'date', { required: true, condition: { field: 'repayment_type', in: ['lump_sum'] }, kv_block: 'K4' }),
        f('total_interest_amount', 'decimal', { required: true, default: '0', min_value: '0', condition: { field: 'interest_type', in: ['rate'] }, kv_block: 'K4' }),
        f('schedule', 'list', { required: true, condition: { field: 'repayment_type', in: ['schedule'] }, kv_block: 'K4' }),
      ],
    },
    {
      key: 'transfer',
      title_i18n_key: 'contract_forms.loan.section.transfer',
      external_entity: null,
      fields: [
        f('transfer_method', 'choice', { required: true, choices: ['platform', 'off_platform'], kv_block: 'K3' }),
        f('transfer_confirmation_note', 'text', { required: true, condition: { field: 'transfer_method', in: ['off_platform'] }, kv_block: 'K3' }),
      ],
    },
    {
      key: 'options',
      title_i18n_key: 'contract_forms.loan.section.options',
      external_entity: null,
      fields: [
        f('early_repayment_allowed', 'boolean', { default: true, kv_block: 'V-LOAN' }),
        f('purpose', 'text', { kv_block: 'V-LOAN' }),
      ],
    },
  ],
};

/** Реестр схем по коду типа договора — зеркало `forms._REGISTRY`.
 * `services_individual`/`services_business` делят одну схему (как на бэке). */
const REGISTRY: Record<string, FormSchemaDto> = {
  services_individual: SERVICE_FORM_SCHEMA,
  services_business: SERVICE_FORM_SCHEMA,
  sale_personal: SALE_PERSONAL_FORM_SCHEMA,
  sale_business: SALE_BUSINESS_FORM_SCHEMA,
  rent_items: RENT_ITEMS_FORM_SCHEMA,
  rent_home: RENT_HOME_FORM_SCHEMA,
  loan_individuals: LOAN_FORM_SCHEMA,
};

export function formSchemaFor(contractTypeCode: string): FormSchemaDto | null {
  return REGISTRY[contractTypeCode] ?? null;
}

export function formSchemaHasField(contractTypeCode: string, key: string): boolean {
  // Нет схемы у типа — адрес `form.<key>` неприменим (бэк: `revision_item_unknown`).
  const schema = formSchemaFor(contractTypeCode);
  if (!schema) return false;
  return schema.sections.some((s) => s.fields.some((x) => x.key === key));
}

export function formSchemaFieldType(contractTypeCode: string, key: string): FormFieldSpec['type'] | null {
  for (const s of formSchemaFor(contractTypeCode)?.sections ?? []) for (const x of s.fields) if (x.key === key) return x.type;
  return null;
}
