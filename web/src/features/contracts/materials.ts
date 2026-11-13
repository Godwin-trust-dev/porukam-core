import type { TFunction } from 'i18next';
import type { ContractRole, MaterialCatalogItem, RealContractMaterial, RealContractMaterialCreateInput } from '@porukam/core';
import type { MaterialsModalDraftItem, MaterialsModalLabels } from '@porukam/ui';

/**
 * Материалы этапа: перевод между окном «Материалы» (`MaterialsModalDraftItem`,
 * @porukam/ui) и ресурсом бэкенда (`ContractMaterial`, `GET/POST
 * /milestones/{id}/materials`). Общий модуль — мастер (шаг «Этапы») и карточка
 * договора работают с одним и тем же представлением.
 */

/** Позиция каталога, уже созданная на сервере, живёт в окне под `srv-<uuid>`
 * (тот же приём, что у пунктов чек-листа в мастере) — по «Далее» такие идут
 * в PATCH/DELETE, а без префикса — в POST. */
export const SERVER_MATERIAL_PREFIX = 'srv-';
export const isServerMaterialId = (id: string): boolean => id.startsWith(SERVER_MATERIAL_PREFIX);
export const serverMaterialId = (id: string): string => id.slice(SERVER_MATERIAL_PREFIX.length);

/** «12.000» → «12», «0.500» → «0.5»: бэк отдаёт Decimal с тремя знаками, в поле
 * количества человеку нужен его же ввод. */
function trimDecimal(value: string | null): string {
  if (!value) return '';
  return value.includes('.') ? value.replace(/0+$/, '').replace(/\.$/, '') : value;
}

export function toDraftMaterial(m: RealContractMaterial): MaterialsModalDraftItem {
  return {
    id: `${SERVER_MATERIAL_PREFIX}${m.id}`,
    catalogRef: m.catalog_item_code,
    title: m.description,
    quantity: trimDecimal(m.quantity),
    unitCode: m.unit ?? '',
    deliveryDays: m.delivery_days ? String(m.delivery_days) : '',
    deliveryBase: m.delivery_base ?? 'contract_signing',
    suppliedBy: m.source,
    unitPrice: m.unit_price,
  };
}

/** Тело `POST /milestones/{id}/materials` (и `PATCH /materials/{id}`).
 * Деньги — пара (`unit_price` + `unit_price_currency`), валюта договора;
 * `description` — то, что человек видит названием позиции. */
export function toMaterialInput(item: MaterialsModalDraftItem, currency: string): RealContractMaterialCreateInput {
  return {
    catalog_item_code: item.catalogRef,
    description: item.title,
    source: item.suppliedBy,
    unit_price: item.unitPrice || '0.00',
    unit_price_currency: currency,
    quantity: item.quantity ? item.quantity.replace(',', '.') : '0',
    unit: item.unitCode,
    delivery_days: Number(item.deliveryDays) || 0,
    delivery_base: item.deliveryBase,
  };
}

/** Материал изменился относительно серверного — тогда по «Далее» уходит PATCH. */
export function materialChanged(server: RealContractMaterial, item: MaterialsModalDraftItem, currency: string): boolean {
  const next = toMaterialInput(item, currency);
  return (
    server.catalog_item_code !== next.catalog_item_code ||
    server.description !== next.description ||
    server.source !== next.source ||
    Number(server.unit_price) !== Number(next.unit_price) ||
    server.unit_price_currency !== next.unit_price_currency ||
    Number(server.quantity ?? 0) !== Number(next.quantity ?? 0) ||
    (server.unit ?? '') !== (next.unit ?? '') ||
    (server.delivery_days ?? 0) !== (next.delivery_days ?? 0) ||
    (server.delivery_base ?? 'contract_signing') !== next.delivery_base
  );
}

/**
 * ADR-155 §6 — состояние передачи материала. Материалы ИСПОЛНИТЕЛЯ
 * (`source=contractor`) гейт не блокируют (domain-model.md §7.3) и
 * подтверждений на экране не требуют — у них только пометка «поставляет
 * исполнитель». У материалов ЗАКАЗЧИКА три состояния подряд: ожидается →
 * передано → получено.
 */
export type MaterialHandoverState = 'contractor_supplied' | 'expected' | 'handed_over' | 'received';

export function materialHandoverState(m: RealContractMaterial): MaterialHandoverState {
  if (m.source === 'contractor') return 'contractor_supplied';
  if (m.received) return 'received';
  return m.handed_over_at ? 'handed_over' : 'expected';
}

/** «Передал» отмечает сторона-ИСТОЧНИК: у материала заказчика — заказчик
 * (бэк: 403 `material_handover_wrong_side` любой другой стороне). Повтор
 * идемпотентен, но кнопку после отметки не показываем — нажимать нечего. */
export function canMarkHandedOver(m: RealContractMaterial, role: ContractRole | undefined): boolean {
  return m.source === 'customer' && role === 'customer' && !m.received && !m.handed_over_at;
}

/** «Получил» отмечает ДРУГАЯ сторона — и ровно этот шаг двигает гейт старта.
 * «Передано» НЕ предусловие: исполнитель вправе поставить «получены»
 * односторонне (владелец 03.09, «сделаем жизнь людям чуть легче»). */
export function canMarkReceived(m: RealContractMaterial, role: ContractRole | undefined): boolean {
  return m.source === 'customer' && role === 'contractor' && !m.received;
}

/**
 * Каталог материалов для окна: обязательная позиция «Прочее» есть у КАЖДОЙ сферы
 * (`other_<sphere>`, domain-model.md §7.3), поэтому без фильтра по сфере список
 * содержит десяток одинаковых «Прочее». Оставляем ОДНУ — свою по сфере договора
 * (иначе первую попавшуюся) — и отдаём её код окну как `otherRef`: выбор этой
 * позиции открывает поле свободного названия.
 */
export function resolveMaterialCatalog(
  catalog: MaterialCatalogItem[],
  sphereCode: string,
): { items: MaterialCatalogItem[]; otherRef: string } {
  const isOther = (ref: string): boolean => ref === 'other' || ref.startsWith('other_');
  const otherRef =
    catalog.find((c) => c.ref === `other_${sphereCode}`)?.ref ?? catalog.find((c) => isOther(c.ref))?.ref ?? 'other';
  return { items: catalog.filter((c) => !isOther(c.ref) || c.ref === otherRef), otherRef };
}

/** Строки окна «Материалы» — один набор на мастер и карточку договора. */
export function buildMaterialsModalLabels(t: TFunction): MaterialsModalLabels {
  return {
    title: t('contractNew.materials.title'),
    cancel: t('contractNew.materials.cancel'),
    done: t('contractNew.materials.done'),
    nameLabel: t('contractNew.materials.nameLabel'),
    otherOption: t('contractNew.materials.otherOption'),
    customNameLabel: t('contractNew.materials.customNameLabel'),
    customNamePlaceholder: t('contractNew.materials.customNamePlaceholder'),
    customNameHint: t('contractNew.materials.customNameHint'),
    nameRequired: t('contractNew.materials.nameRequired'),
    searchNoMatch: t('contractNew.materials.searchNoMatch', { other: t('contractNew.materials.otherOption') }),
    quantityLabel: t('contractNew.materials.quantityLabel'),
    quantityPlaceholder: t('contractNew.materials.quantityPlaceholder'),
    unitLabel: t('contractNew.materials.unitLabel'),
    unitChoose: t('contractNew.materials.unitChoose'),
    deliveryLabel: t('contractNew.materials.deliveryLabel'),
    deliveryPlaceholder: t('contractNew.materials.deliveryPlaceholder'),
    deliveryBaseLabel: t('contractNew.materials.deliveryBaseLabel'),
    deliveryBaseSigning: t('contractNew.materials.deliveryBaseSigning'),
    deliveryBasePrepayment: t('contractNew.materials.deliveryBasePrepayment'),
    deliveryBaseStageStart: t('contractNew.materials.deliveryBaseStageStart'),
    suppliedByLabel: t('contractNew.materials.suppliedByLabel'),
    suppliedByChoose: t('contractNew.materials.suppliedByChoose'),
    suppliedByCustomer: t('contractNew.materials.suppliedByCustomer'),
    suppliedByContractor: t('contractNew.materials.suppliedByContractor'),
    suppliedByRequired: t('contractNew.materials.suppliedByRequired'),
    priceLabel: t('contractNew.materials.priceLabel'),
    pricePlaceholder: t('contractNew.materials.pricePlaceholder'),
    priceRequired: t('contractNew.materials.priceRequired'),
    addToList: t('contractNew.materials.addToList'),
    saveItem: t('contractNew.materials.saveItem'),
    cancelEdit: t('contractNew.materials.cancelEdit'),
    editAria: t('contractNew.materials.editAria'),
    deleteAria: t('contractNew.materials.deleteAria'),
    formatDeliveryMeta: (days, base) => t('contractNew.materials.deliveryMeta', { days, base }),
    formatSuppliedByMeta: (name) => t('contractNew.materials.suppliedByMeta', { name }),
    unitPickerTitle: t('contractNew.unitPicker.title'),
    closeLabel: t('common.close'),
    nameHelp: t('hints.stage.materials.name'),
    customNameHelp: t('hints.stage.materials.customName'),
    quantityHelp: t('hints.stage.materials.quantity'),
    unitHelp: t('hints.stage.materials.unit'),
    deliveryHelp: t('hints.stage.materials.delivery'),
    deliveryBaseHelp: t('hints.stage.materials.deliveryBase'),
    suppliedByHelp: t('hints.stage.materials.suppliedBy'),
    priceHelp: t('hints.stage.materials.price'),
    helpLabel: t('hints.helpButton'),
  };
}
