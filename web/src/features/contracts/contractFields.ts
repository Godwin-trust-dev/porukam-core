import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { ApiError, type RealContract, type RealContractMaterial, type RealMilestoneTreeNode } from '@porukam/core';
import {
  useFormSchema,
  choiceLabelKey,
  fieldLabelKey,
  fieldVisible,
  schemaI18nName,
  valuesFromFormData,
  type FormFieldSpec,
  type FormSchemaDto,
} from '../contractNew/formSchema';
import { formDataErrorText } from '../contractNew/serviceFormData';
import { PAYMENT_ORDERS, PAYMENT_ORDER_LABEL_KEY, paymentOrderApplicableForType } from '../contractNew/paymentOrders';
import { PAY_LABEL_KEY } from './RealContractRow';
import { resolveMaterialCatalog } from './materials';
import { useRealContractMilestones, useRealMaterialsOfMilestones } from './realApi';
import { useMaterialCatalog } from '../contractNew/api';
import { useFormatters } from '../../shared/formatters';

/**
 * Общий словарь «ключ поля `form_data` → человеческая подпись» и разбор
 * значений. Выделен из `RealTermsPanel` (вкладка «Условия»), потому что тем же
 * словарём теперь подписывается выпадающий список «Что меняем» в правке
 * (ADR-123): человек выбирает поле теми же словами, которыми оно названо в
 * условиях договора и в мастере, а не служебным ключом `form.warranty_period_days`.
 *
 * Подписи берутся из ключей, которыми поля уже подписывает мастер (услуга —
 * `contractNew.serviceForm.*`/`contractNew.*`, продажа — `contractNew.saleForm.*`/
 * `contractNew.typeForm.sale.*`); аренда/займ — из схемы бэка
 * (`contractNew.schemaForm.<name>.field.<key>`). Никаких новых словарей на 29
 * языков: условия читаются теми же словами, что вводились.
 */
export const FIELD_LABEL_KEYS: Record<string, string> = {
  work_description: 'contractNew.serviceForm.workDescriptionLabel',
  location_type: 'contractNew.serviceForm.locationTypeLabel',
  location_address: 'contractNew.serviceForm.locationAddressLabel',
  term_type: 'contractNew.serviceForm.termTypeLabel',
  start_date: 'contractNew.serviceForm.startLabel',
  end_date: 'contractNew.serviceForm.endLabel',
  duration_days: 'contractNew.serviceForm.durationDaysLabel',
  price_type: 'contractNew.serviceForm.priceTypeLabel',
  warranty_period_days: 'contractNew.warrantyDaysLabel',
  acceptance_window_hours: 'contractNew.acceptanceHoursLabel',
  subcontract_policy: 'contractNew.subcontractLabel',
  access_required: 'contractNew.premisesAccessLabel',
  portfolio_visible: 'contractNew.portfolioConsentLabel',
  category_code: 'contractNew.saleForm.categoryLabel',
  item_name: 'contractNew.typeForm.sale.whatLabel',
  item_description: 'contractNew.typeForm.sale.descriptionLabel',
  condition: 'contractNew.typeForm.sale.conditionLabel',
  condition_defects_description: 'contractNew.typeForm.sale.defectsLabel',
  completeness: 'contractNew.typeForm.sale.completenessLabel',
  identifiers: 'contractNew.saleForm.identifiersLabel',
  own_household_plot: 'contractNew.saleForm.householdPlotLabel',
  price: 'contractNew.typeForm.sale.priceLabel',
  delivery_type: 'contractNew.typeForm.sale.deliveryTypeLabel',
  delivery_address: 'contractNew.typeForm.sale.addressLabel',
  delivery_payer: 'contractNew.saleForm.deliveryPayerLabel',
  delivery_deadline_type: 'contractNew.typeForm.sale.deliveryTermLabel',
  delivery_date: 'contractNew.saleForm.deliveryDateLabel',
  delivery_days: 'contractNew.saleForm.deliveryDaysLabel',
  tracking_number: 'contractNew.saleForm.trackingLabel',
  inspection_window_hours: 'contractNew.saleForm.inspectionHoursLabel',
};

export const CHOICE_LABEL_KEYS: Record<string, Record<string, string>> = {
  location_type: { onsite: 'contractNew.serviceForm.locationOnsite', remote: 'contractNew.serviceForm.locationRemote' },
  term_type: { dates: 'contractNew.serviceForm.termDates', relative_to_gate: 'contractNew.serviceForm.termRelative' },
  price_type: { fixed: 'contractNew.serviceForm.priceFixed', estimate: 'contractNew.serviceForm.priceEstimate' },
  subcontract_policy: {
    forbidden: 'contractNew.subcontractForbidden',
    allowed: 'contractNew.subcontractAllowed',
    with_consent: 'contractNew.subcontractWithConsent',
  },
  condition: { new: 'contractNew.typeForm.sale.conditionNew', used: 'contractNew.typeForm.sale.conditionUsed' },
  delivery_payer: { seller: 'contractNew.saleForm.payerSeller', buyer: 'contractNew.saleForm.payerBuyer', split: 'contractNew.saleForm.payerSplit' },
  delivery_deadline_type: { date: 'contractNew.saleForm.deadlineDate', relative_to_payment: 'contractNew.saleForm.deadlineRelative' },
};

export const CHOICE_PREFIX_KEYS: Record<string, string> = {
  category_code: 'contractNew.saleForm.category.',
  delivery_type: 'contractNew.saleForm.delivery.',
};

/** Служебные поля, которые показываются не как «поле формы». */
export const HIDDEN_KEYS = new Set(['schema_version', 'photos', 'sphere_code']);

export function humanize(key: string): string {
  return key.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
}

/** Тип поля, выведенный из значения, — для форм без схемы бэка (услуга/продажа). */
export function inferFieldType(raw: unknown): FormFieldSpec['type'] {
  if (typeof raw === 'boolean') return 'boolean';
  if (typeof raw === 'number') return Number.isInteger(raw) ? 'integer' : 'decimal';
  if (Array.isArray(raw)) return 'list_str';
  if (typeof raw === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw)) return 'date';
  if (typeof raw === 'string' && raw.length > 80) return 'text';
  return 'string';
}

export interface ContractFieldLabeller {
  schema: FormSchemaDto | undefined;
  fieldByKey: Map<string, FormFieldSpec>;
  /** Человеческая подпись поля `form_data` по ключу. */
  labelOf: (key: string) => string;
  /** Человеческое значение поля (`null` — пусто, показывать нечего). */
  valueOf: (key: string, raw: unknown) => string | null;
  /** Подпись варианта `choice` (или сам код, если словаря нет). */
  choiceLabelOf: (key: string, value: string) => string;
}

/**
 * Подписи полей и значений одного договора. Общий источник для вкладки
 * «Условия» и выпадающего списка «Что меняем» — чтобы поле в правке
 * называлось ровно так же, как в тексте договора.
 */
export function useContractFieldLabeller(contractTypeCode: string): ContractFieldLabeller {
  const { t, i18n } = useTranslation();
  const { formatDate } = useFormatters();
  const { data: schema } = useFormSchema(contractTypeCode);
  const schemaName = schema ? schemaI18nName(schema) : '';

  const fieldByKey = new Map<string, FormFieldSpec>();
  for (const section of schema?.sections ?? []) for (const f of section.fields) fieldByKey.set(f.key, f);

  const labelOf = (key: string): string => {
    const spec = fieldByKey.get(key);
    if (spec && schemaName && i18n.exists(fieldLabelKey(schemaName, spec))) return t(fieldLabelKey(schemaName, spec));
    const mapped = FIELD_LABEL_KEYS[key];
    if (mapped && i18n.exists(mapped)) return t(mapped);
    return humanize(key);
  };

  const choiceLabelOf = (key: string, value: string): string => {
    const spec = fieldByKey.get(key);
    if (spec?.type === 'choice' && schemaName && i18n.exists(choiceLabelKey(schemaName, spec, value))) {
      return t(choiceLabelKey(schemaName, spec, value));
    }
    const choiceKey = CHOICE_LABEL_KEYS[key]?.[value] ?? (CHOICE_PREFIX_KEYS[key] ? `${CHOICE_PREFIX_KEYS[key]}${value}` : undefined);
    if (choiceKey && i18n.exists(choiceKey)) return t(choiceKey);
    return value;
  };

  const valueOf = (key: string, raw: unknown): string | null => {
    if (raw === null || raw === undefined || raw === '') return null;
    // Отсмотр 2026-08-25: в тексте условий тумблер читается как ответ на вопрос
    // («Можно с животными» — Да/Нет), а не как состояние переключателя.
    if (typeof raw === 'boolean') return t(raw ? 'common.yes' : 'common.no');
    if (Array.isArray(raw)) {
      if (raw.length === 0) return null;
      if (typeof raw[0] === 'object' && raw[0] !== null) {
        return raw
          .map((r) => {
            const row = r as { due_date?: string; amount?: string };
            return [row.due_date ? formatDate(row.due_date) : '', row.amount ?? ''].filter(Boolean).join(' — ');
          })
          .join('; ');
      }
      return raw.map(String).join(', ');
    }
    const s = String(raw);
    const labelled = choiceLabelOf(key, s);
    if (labelled !== s) return labelled;
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return formatDate(s);
    return s;
  };

  return { schema, fieldByKey, labelOf, valueOf, choiceLabelOf };
}

/** Один пункт выпадающего списка «Что меняем» (ADR-123, ADR-157). */
export interface RevisionItemOption {
  /** `item_ref` для API: `title` | `other` | `form.<key>` | `payment.method` |
   * `payment.order` | `milestone.<uuid>.<поле>` | `material.<uuid>.<поле>`.
   * Все они АДРЕСУЕМЫЕ: принятую правку бэк применяет к договору сам
   * (`apps.contracts.services.is_addressable_item_ref`, ADR-157 §1) — ручных
   * пунктов, которые стороны вносят в текст руками, в списке больше нет. */
  ref: string;
  label: string;
  /** Тип виджета «Стало». */
  type: FormFieldSpec['type'];
  /** Варианты для `choice` — пары «код → подпись». */
  choices: { value: string; label: string }[] | null;
  /** Сырое текущее значение поля договора. */
  current: unknown;
  /** Текущее значение по-человечески — показывается в поле «Было» и серой
   * второй строкой в комбобоксе «Что меняем». */
  currentText: string;
  /** Раздел договора — заголовок секции в комбобоксе. */
  group?: string;
  /** Валюта денежной правки: значение уходит на бэк ПАРОЙ
   * `{amount, currency}` (ADR-157 §1; CLAUDE.md — валюты по умолчанию нет
   * нигде). Задана только у сумм этапов. */
  currency?: string;
  /** Длинный справочник — «Стало» рисуется комбобоксом с поиском
   * (`SearchSelect`), тем же, которым тип материала выбирается в «Материалах». */
  searchable?: boolean;
}

/**
 * Значение «предшественника нет» в списке «Стало» там, где ПУСТО — законный
 * ответ (условие старта этапа). Отдельный код нужен, чтобы отличить «выбрал
 * „нет предшественника“» от «ещё ничего не выбрал»: на бэк вместо него уходит
 * пустая строка (ADR-157 §1, `_clean_start_gate_value`).
 */
export const REVISION_NO_VALUE = '__none__';

/** Поля структурных адресов ADR-157 — те же, что знает `parse_structured_ref`. */
const STRUCTURED_REVISION_FIELDS: Record<string, readonly string[]> = {
  milestone: ['title', 'amount', 'deadline', 'start_gate'],
  material: ['type', 'quantity', 'delivery_days'],
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Адреса, которые бэк применяет при принятии правки — зеркало
 * `apps.contracts.services.is_addressable_item_ref` (ADR-123 + ADR-157 §1). */
export function isAddressableRevisionRef(ref: string): boolean {
  if (ref === 'title' || ref === 'other' || ref === 'payment.method' || ref === 'payment.order') return true;
  if (ref.startsWith('form.')) return true;
  const [kind, id, field] = ref.split('.');
  const fields = STRUCTURED_REVISION_FIELDS[kind ?? ''];
  return !!fields && !!id && UUID_RE.test(id) && fields.includes(field ?? '');
}

/** Листья дерева этапов в порядке обхода — платят и принимают именно их. */
function leafMilestones(nodes: RealMilestoneTreeNode[]): RealMilestoneTreeNode[] {
  const out: RealMilestoneTreeNode[] = [];
  const walk = (list: RealMilestoneTreeNode[]): void => {
    for (const node of [...list].sort((a, b) => a.order - b.order)) {
      if (node.is_leaf) out.push(node);
      walk(node.children ?? []);
    }
  };
  walk(nodes);
  return out;
}

/**
 * Список пунктов договора для «Что меняем» (ADR-123 + замечание владельца
 * 03.09: «в „Предложить правку“ нет ни типа оплаты и условий оплаты, надо
 * чтобы были все пункты» — выбираемо всё, что видно в «Обзоре»).
 *
 * Секции комбобокса:
 * - «Оплаты» — способ расчёта (`payment.method`) и порядок оплаты
 *   (`payment.order`, ADR-151; у займа неприменим);
 * - «Этапы» — по каждому ЛИСТУ дерева: название, сумма, срок, условие старта
 *   (`milestone.<id>.<field>`);
 * - «Материалы» — по каждой позиции: тип, количество, срок поставки
 *   (`material.<id>.<field>`);
 * - «Условия» — название договора и ВИДИМЫЕ поля схемы бэка
 *   (`GET /contract-types/{code}/form-schema`), ровно те адреса `form.<key>`,
 *   которые бэк примет: неизвестный ключ он отвергает как
 *   `revision_item_unknown`. Условно скрытые (`condition`) не предлагаем —
 *   менять адрес объекта у удалённой работы нечего. Секции схемы с
 *   `external_entity` (этапы, материалы) — не поля формы, пропускаем, они
 *   собираются выше из реальных сущностей;
 * - «Другое» — свой текст, без секции, последним.
 *
 * Если схема не загрузилась (моки dev-контура знают не все типы), падаем на
 * фактические ключи `form_data` — иначе список был бы из двух пунктов.
 *
 * ВАЖНО про бэк (ADR-157): принятую правку он применяет по ВСЕМ этим адресам
 * сам — и по оплате, и по этапам, и по материалам. Отсюда три требования к
 * значениям, которых не было у свободных адресов: тип материала уходит КОДОМ
 * позиции каталога, условие старта — идентификатором этапа-предшественника,
 * сумма этапа — парой `{amount, currency}`.
 */
export function useRevisionItemOptions(contract: RealContract): RevisionItemOption[] {
  const { t } = useTranslation();
  const { formatDate, formatMoney } = useFormatters();
  const { schema, fieldByKey, labelOf, valueOf, choiceLabelOf } = useContractFieldLabeller(contract.contract_type_code);
  const formData = contract.form_data ?? {};

  const milestonesQ = useRealContractMilestones(contract.id);
  const leaves = useMemo(() => leafMilestones(milestonesQ.data ?? []), [milestonesQ.data]);
  const leafIds = useMemo(() => leaves.map((m) => m.id), [leaves]);
  const materialsQs = useRealMaterialsOfMilestones(leafIds);
  const materials: { milestone: RealMilestoneTreeNode; item: RealContractMaterial }[] = [];
  leaves.forEach((milestone, i) => {
    for (const item of materialsQs[i]?.data ?? []) materials.push({ milestone, item });
  });

  // Каталог материалов — ТОТ ЖЕ источник, что у окна «Материалы»
  // (`GET /material-catalog`, ADR-047/155): правка типа шлёт код позиции, а
  // не свободный текст. Запрос без `sphere` — один на карточку: сферы у
  // этапов дерева могут быть разные, а «Прочее» своей сферы отбирает уже
  // `resolveMaterialCatalog` (иначе в списке был бы десяток одинаковых).
  const { data: materialCatalog } = useMaterialCatalog();
  const contractSphere = typeof formData.sphere_code === 'string' ? formData.sphere_code : '';
  const catalogTitleOf = useMemo(
    () => new Map((materialCatalog ?? []).map((c) => [c.ref, c.title])),
    [materialCatalog],
  );

  const groupTerms = t('contract.tabs.terms');
  const groupPayment = t('contract.tabs.payments');
  const groupStages = t('contract.tabs.stages');
  const groupMaterials = t('contract.materialsTitle');
  /** «Этап · Сумма» — в подписи видно и к чему пункт относится, и что меняем. */
  const sub = (owner: string, field: string): string => `${owner} · ${field}`;

  const options: RevisionItemOption[] = [];

  // --- Оплаты (ADR-151/155) ------------------------------------------------
  options.push({
    ref: 'payment.method',
    label: t('contract.card.moneyMethodLabel'),
    type: 'choice',
    choices: (Object.keys(PAY_LABEL_KEY) as (keyof typeof PAY_LABEL_KEY)[]).map((code) => ({
      value: code,
      label: t(PAY_LABEL_KEY[code]),
    })),
    current: contract.payment_method,
    currentText: contract.payment_method ? t(PAY_LABEL_KEY[contract.payment_method]) : t('contracts.payNone'),
    group: groupPayment,
  });
  if (paymentOrderApplicableForType(contract.contract_type_code)) {
    options.push({
      ref: 'payment.order',
      label: t('contractNew.paymentOrderLabel'),
      type: 'choice',
      choices: PAYMENT_ORDERS.map((code) => ({ value: code, label: t(PAYMENT_ORDER_LABEL_KEY[code]) })),
      current: contract.payment_order,
      currentText: contract.payment_order
        ? t(PAYMENT_ORDER_LABEL_KEY[contract.payment_order])
        : t('contracts.payOrderNone'),
      group: groupPayment,
    });
  }

  // --- Этапы: только листья (ветки группируют, платят и принимают листья) ---
  const titleOf = new Map(leaves.map((m) => [m.id, m.title]));
  /** Валюта денежной правки: своя валюта листа, иначе валюта договора —
   * та же логика, что у бэка (`_revision_currency`). Пусто — у договора ещё
   * нет ни одной суммы; валюты по умолчанию не подставляем (CLAUDE.md). */
  const contractCurrency = contract.total?.currency ?? undefined;
  for (const m of leaves) {
    options.push({
      ref: `milestone.${m.id}.title`,
      label: sub(m.title, t('contract.amendment.fieldTitle')),
      type: 'string',
      choices: null,
      current: m.title,
      currentText: m.title,
      group: groupStages,
    });
    const amountCurrency = m.currency ?? contractCurrency;
    options.push({
      ref: `milestone.${m.id}.amount`,
      label: sub(m.title, t('contract.amendment.fieldAmount')),
      type: 'decimal',
      choices: null,
      // Деньги — всегда пара: и «Было», и «Стало» (ADR-157 §1).
      current: m.amount && m.currency ? { amount: m.amount, currency: m.currency } : null,
      currentText: m.amount && m.currency ? formatMoney({ amount: m.amount, currency: m.currency }) : '',
      group: groupStages,
      ...(amountCurrency ? { currency: amountCurrency } : {}),
    });
    options.push({
      ref: `milestone.${m.id}.deadline`,
      label: sub(m.title, t('contract.amendment.fieldDeadline')),
      type: 'date',
      choices: null,
      current: m.deadline,
      currentText: m.deadline ? formatDate(m.deadline, { legal: true }) : '',
      group: groupStages,
    });
    // Условие старта — это `Milestone.depends_on` (ADR-157 §1): выбор
    // этапа-предшественника из ЛИСТЬЕВ этого договора, а не свободный текст.
    // Расчётные условия гейта (подписан / материалы переданы / деньги
    // подтверждены) выводятся из фактов, договориться о них правкой нельзя.
    options.push({
      ref: `milestone.${m.id}.start_gate`,
      label: sub(m.title, t('contract.revisionFieldStartGate')),
      type: 'choice',
      choices: [
        { value: REVISION_NO_VALUE, label: t('contract.revisionStartGateNone') },
        // Сам на себя этап зависеть не может (бэк: `self_reference`).
        ...leaves.filter((o) => o.id !== m.id).map((o) => ({ value: o.id, label: o.title })),
      ],
      current: m.depends_on_id,
      currentText: m.depends_on_id ? titleOf.get(m.depends_on_id) ?? '' : '',
      group: groupStages,
    });
  }

  // --- Материалы (ADR-047/155) ---------------------------------------------
  for (const { milestone, item } of materials) {
    const { items: catalogItems } = resolveMaterialCatalog(
      materialCatalog ?? [],
      milestone.sphere_code ?? contractSphere,
    );
    options.push({
      ref: `material.${item.id}.type`,
      label: sub(item.description, t('contractNew.materials.nameLabel')),
      // Тип материала — КЛАССИФИКАТОР: код позиции каталога, а не текст
      // (ADR-157 §1, `unknown_catalog_item`); свободное уточнение названия
      // правится не здесь.
      type: 'choice',
      choices: catalogItems.map((c) => ({ value: c.ref, label: c.title })),
      searchable: true,
      current: item.catalog_item_code,
      currentText: catalogTitleOf.get(item.catalog_item_code) ?? item.description,
      group: groupMaterials,
    });
    options.push({
      ref: `material.${item.id}.quantity`,
      label: sub(item.description, t('contract.amendment.fieldQuantity')),
      type: 'decimal',
      choices: null,
      current: item.quantity,
      currentText: [item.quantity, item.unit].filter(Boolean).join(' '),
      group: groupMaterials,
    });
    options.push({
      ref: `material.${item.id}.delivery_days`,
      label: sub(item.description, t('contractNew.materials.deliveryLabel')),
      type: 'integer',
      choices: null,
      current: item.delivery_days,
      currentText: item.delivery_days ? String(item.delivery_days) : '',
      group: groupMaterials,
    });
  }

  // --- Условия: название договора и поля формы -----------------------------
  options.push({
    ref: 'title',
    label: t('contract.revisionItemTitle'),
    type: 'string',
    choices: null,
    current: contract.title,
    currentText: contract.title,
    group: groupTerms,
  });

  const keys: string[] = [];
  if (schema) {
    const values = valuesFromFormData(schema, formData);
    for (const section of schema.sections) {
      if (section.external_entity) continue;
      for (const f of section.fields) {
        if (HIDDEN_KEYS.has(f.key) || !fieldVisible(f, values)) continue;
        keys.push(f.key);
      }
    }
  } else {
    for (const key of Object.keys(formData)) {
      if (HIDDEN_KEYS.has(key)) continue;
      keys.push(key);
    }
  }

  for (const key of keys) {
    const spec = fieldByKey.get(key);
    const raw = formData[key];
    const type = spec?.type ?? inferFieldType(raw);
    options.push({
      ref: `form.${key}`,
      label: labelOf(key),
      type,
      choices: spec?.choices ? spec.choices.map((c) => ({ value: c, label: choiceLabelOf(key, c) })) : null,
      current: raw ?? null,
      currentText: valueOf(key, raw) ?? '',
      group: groupTerms,
    });
  }

  options.push({
    ref: 'other',
    label: t('contract.revisionItemOther'),
    type: 'text',
    choices: null,
    current: null,
    currentText: '',
  });

  return options;
}

/** Словарь правок одного договора: список для «Что меняем» + подписи адресов и значений. */
export interface RevisionItems {
  options: RevisionItemOption[];
  byRef: Map<string, RevisionItemOption>;
  /** Подпись адреса правки; «свободный» адрес старых правок — как есть. */
  labelOf: (itemRef: string) => string;
  /** Значение правки по-человечески: коды `choice` и булевы — словами. */
  valueTextOf: (itemRef: string, raw: unknown) => string;
}

/** Пара «сумма + валюта» из ответа бэка (`milestone.<uuid>.amount`, ADR-157). */
function asMoney(raw: unknown): { amount: string; currency: string } | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const { amount, currency } = raw as { amount?: unknown; currency?: unknown };
  if (typeof currency !== 'string' || !currency) return null;
  if (typeof amount !== 'string' && typeof amount !== 'number') return null;
  return { amount: String(amount), currency };
}

export function useRevisionItems(contract: RealContract): RevisionItems {
  const { t } = useTranslation();
  const { formatMoney } = useFormatters();
  const options = useRevisionItemOptions(contract);
  const { valueOf } = useContractFieldLabeller(contract.contract_type_code);
  const byRef = new Map(options.map((o) => [o.ref, o]));

  const labelOf = (itemRef: string): string => byRef.get(itemRef)?.label ?? itemRef;

  const valueTextOf = (itemRef: string, raw: unknown): string => {
    if (raw === null || raw === undefined || raw === '') return t('contract.revisionValueEmpty');
    if (itemRef.startsWith('form.')) return valueOf(itemRef.slice('form.'.length), raw) ?? t('contract.revisionValueEmpty');
    if (typeof raw === 'boolean') return t(raw ? 'common.yes' : 'common.no');
    // Деньги приходят парой (ADR-157 §1) — показываем суммой с валютой, а не
    // JSON-ом; код позиции каталога, идентификатор этапа-предшественника и
    // коды справочников оплаты — подписью из того же списка «Что меняем».
    const money = asMoney(raw);
    if (money) return formatMoney(money);
    const choice = byRef.get(itemRef)?.choices?.find((c) => c.value === String(raw));
    if (choice) return choice.label;
    if (typeof raw === 'object') return JSON.stringify(raw);
    return String(raw);
  };

  return { options, byRef, labelOf, valueTextOf };
}

/**
 * Строка из виджета «Стало» → значение для API. Типы соблюдаем на клиенте, а не
 * надеемся на мягкое приведение бэка: `form_data` уходит в снимок версии, и
 * `"14"` вместо `14` в юридическом тексте — уже другое значение.
 */
export function coerceRevisionValue(type: FormFieldSpec['type'], raw: string): unknown {
  switch (type) {
    case 'boolean':
      return raw === 'true';
    case 'integer': {
      const n = Number.parseInt(raw, 10);
      return Number.isNaN(n) ? raw : n;
    }
    case 'decimal':
      return raw.replace(',', '.').trim();
    case 'list_str':
      return raw
        .split(/[,\n;]/)
        .map((x) => x.trim())
        .filter(Boolean);
    default:
      return raw;
  }
}

/**
 * Строка из виджета «Стало» → значение для API С УЧЁТОМ АДРЕСА (ADR-157):
 * сумма этапа уходит парой `{amount, currency}` (валюты по умолчанию нет
 * нигде — CLAUDE.md), «нет предшественника» — пустой строкой, остальное —
 * по типу поля.
 */
export function coerceRevisionValueForOption(option: RevisionItemOption, raw: string): unknown {
  if (option.currency) {
    return { amount: String(coerceRevisionValue('decimal', raw)), currency: option.currency };
  }
  if (raw === REVISION_NO_VALUE) return '';
  return coerceRevisionValue(option.type, raw);
}

/** Текущее значение → строка для виджета «Стало», по ТИПУ поля. */
function revisionValueToInput(type: FormFieldSpec['type'], raw: unknown): string {
  if (raw === null || raw === undefined) return '';
  // `list` — структурные строки (график платежей займа): «Стало» их не
  // редактирует, склеивать объекты в текст нечестно.
  if (type === 'list') return '';
  if (type === 'boolean') return raw ? 'true' : 'false';
  // Сроки этапов приходят ДАТОЙ-ВРЕМЕНЕМ (`DateTimeField` бэка), а виджет —
  // `input[type=date]`: полный ISO он молча не примет и покажет пустоту.
  if (type === 'date' && typeof raw === 'string') return raw.slice(0, 10);
  if (Array.isArray(raw)) return raw.map(String).join(', ');
  if (typeof raw === 'object') return '';
  return String(raw);
}

/**
 * Текущее значение пункта → строка для виджета «Стало» (предзаполнение) —
 * ОБРАТНАЯ к `coerceRevisionValueForOption` и с тем же знанием про адрес
 * (ADR-157): сумма этапа лежит парой `{amount, currency}`, «предшественника
 * нет» — свой код `REVISION_NO_VALUE`, остальное — по типу поля.
 *
 * Зачем предзаполнять: правка почти всегда — сдвиг ОТ текущего значения
 * (срок на неделю позже, сумма на пару тысяч выше), и перебивать его руками,
 * глядя в соседнее поле «Было», человек не должен. Пустая строка — законный
 * ответ «предзаполнить нечем»: «Другое» (свободное условие без адреса),
 * значение вне списка вариантов и структурные списки.
 */
export function revisionInputFromOption(option: RevisionItemOption): string {
  // «Другое» — произвольное дополнительное условие, текущего значения нет.
  if (option.ref === 'other') return '';
  const raw = option.current;
  if (option.currency) {
    const money = asMoney(raw);
    return money ? money.amount : '';
  }
  const noValue = option.choices?.some((c) => c.value === REVISION_NO_VALUE);
  if (noValue && (raw === null || raw === undefined || raw === '')) return REVISION_NO_VALUE;
  const value = revisionValueToInput(option.type, raw);
  // Код вне справочника выбрать нельзя: `select` показал бы пустоту, а
  // отправилось бы старое значение из состояния.
  if (option.choices?.length && !option.choices.some((c) => c.value === value)) return '';
  return value;
}

/**
 * Коды полевых ошибок правки (`context.errors[].code`, ADR-157 §2) → ключи
 * подписей. Сообщение бэка русское и служебное («этап … — ветка, сумма
 * задаётся на листьях»); человеку нужен свой текст на своём языке, поэтому
 * читаем КОД, а не строку. Незнакомый код — общий разбор `formDataErrorText`
 * (тот же формат, что у `form_data_invalid` мастера).
 */
const REVISION_ERROR_KEYS: Record<string, string> = {
  required: 'contract.revisionError.required',
  invalid: 'contract.revisionError.invalid',
  invalid_choice: 'contract.revisionError.invalidChoice',
  invalid_type: 'contract.revisionError.invalid',
  max_length: 'contract.revisionError.maxLength',
  negative: 'contract.revisionError.negative',
  not_positive: 'contract.revisionError.notPositive',
  not_a_leaf: 'contract.revisionError.notALeaf',
  self_reference: 'contract.revisionError.selfReference',
  unknown_catalog_item: 'contract.revisionError.unknownCatalogItem',
  currency_mismatch: 'contract.revisionError.currencyMismatch',
  currency_required: 'contract.revisionError.currencyRequired',
  not_applicable: 'contract.revisionError.notApplicable',
};

/**
 * Текст ошибки правки для поля «Стало» (не общий тост: 422 приходит по
 * КОНКРЕТНОМУ полю). `revision_item_unknown` — цель адреса больше не
 * принадлежит договору (этап удалили, пока окно было открыто);
 * `revision_value_invalid` — значение не прошло грамматику поля.
 */
export function revisionErrorText(e: unknown, t: TFunction): string {
  if (e instanceof ApiError) {
    if (e.code === 'revision_item_unknown') return t('contract.revisionError.itemUnknown');
    const ctx = e.problem.context as { errors?: { code?: string }[] } | undefined;
    const keys = (ctx?.errors ?? [])
      .map((x) => (x.code ? REVISION_ERROR_KEYS[x.code] : undefined))
      .filter((k): k is string => !!k);
    if (keys.length) return [...new Set(keys)].map((k) => t(k)).join(' ');
  }
  return formDataErrorText(e) ?? String(e);
}
