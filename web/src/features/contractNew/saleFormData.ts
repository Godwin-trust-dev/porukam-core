/**
 * Сборка `form_data` ПРОДАЖИ под реальную схему бэка
 * (`backend/apps/contracts/forms.py`, SALE_PERSONAL_SCHEMA / SALE_BUSINESS_SCHEMA,
 * версия 1). То же ограничение, что у услуги (serviceFormData.ts): PATCH —
 * полная замена с полной валидацией, условные поля отправляются только когда
 * видимы (иначе 422 unknown/required).
 *
 * Фото (`photos`, list_str, необязательно) мастер не собирает: загрузки
 * файлов в черновик ещё нет — поле не отправляется, сервер даёт только
 * предупреждение для б/у.
 */

export const SALE_CATEGORY_CODES = [
  'electronics',
  'clothing_footwear',
  'furniture_interior',
  'appliances',
  'hobby_sport',
  'books_media',
  'kids',
  'beauty_health',
  'garden_tools',
  'food',
  'pets',
  'auto_parts',
  'building_materials',
  'household',
  'jewelry_watches',
  'handmade_collectibles',
  'business_equipment',
  'other',
] as const;
export type SaleCategoryCode = (typeof SALE_CATEGORY_CODES)[number];

export const SALE_DELIVERY_TYPES = ['pickup', 'handoff', 'pvz', 'courier', 'transport_company'] as const;
export type SaleDeliveryType = (typeof SALE_DELIVERY_TYPES)[number];

/** Типы доставки, при которых сервер требует адрес и плательщика. */
const ADDRESS_REQUIRED: readonly SaleDeliveryType[] = ['pvz', 'courier', 'transport_company'];

export interface SaleEssence {
  categoryCode: SaleCategoryCode;
  itemName: string;
  itemDescription: string;
  condition: 'new' | 'used';
  defects: string;
  completeness: string;
  identifiers: string;
  ownHouseholdPlot: boolean;
  price: string;
  deliveryType: SaleDeliveryType;
  deliveryAddress: string;
  deliveryPayer: 'seller' | 'buyer' | 'split';
  deliveryDeadlineType: 'date' | 'relative_to_payment';
  deliveryDate: string;
  deliveryDays: string;
  trackingNumber: string;
  inspectionWindowHours: string;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : v != null ? String(v) : '');
const oneOf = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T =>
  typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;

export function saleFromFormData(fd: Record<string, unknown>): SaleEssence {
  return {
    categoryCode: oneOf(fd.category_code, SALE_CATEGORY_CODES, 'other'),
    itemName: str(fd.item_name),
    itemDescription: str(fd.item_description),
    condition: fd.condition === 'used' ? 'used' : 'new',
    defects: str(fd.condition_defects_description),
    completeness: str(fd.completeness),
    identifiers: str(fd.identifiers),
    ownHouseholdPlot: fd.own_household_plot === true,
    price: str(fd.price),
    deliveryType: oneOf(fd.delivery_type, SALE_DELIVERY_TYPES, 'pickup'),
    deliveryAddress: str(fd.delivery_address),
    deliveryPayer: oneOf(fd.delivery_payer, ['seller', 'buyer', 'split'] as const, 'seller'),
    deliveryDeadlineType: fd.delivery_deadline_type === 'relative_to_payment' ? 'relative_to_payment' : 'date',
    deliveryDate: str(fd.delivery_date),
    deliveryDays: fd.delivery_days != null ? String(fd.delivery_days) : '',
    trackingNumber: str(fd.tracking_number),
    inspectionWindowHours: fd.inspection_window_hours != null ? String(fd.inspection_window_hours) : '24',
  };
}

export function saleNeedsAddress(e: SaleEssence): boolean {
  return ADDRESS_REQUIRED.includes(e.deliveryType);
}

/** Нормализованная цена («1 200,50» → «1200.50») или '' если это не число. */
export function salePriceNormalized(e: SaleEssence): string {
  const raw = e.price.replace(/\s/g, '').replace(',', '.');
  return raw !== '' && !Number.isNaN(Number(raw)) && Number(raw) >= 0 ? raw : '';
}

/** Все обязательные видимые поля заполнены — форму можно отправлять на сервер. */
export function saleComplete(e: SaleEssence): boolean {
  if (!e.itemName.trim() || !e.itemDescription.trim()) return false;
  if (e.condition === 'used' && !e.defects.trim()) return false;
  if (e.categoryCode === 'electronics' && !e.identifiers.trim()) return false;
  if (salePriceNormalized(e) === '') return false;
  if (saleNeedsAddress(e) && !e.deliveryAddress.trim()) return false;
  if (e.deliveryDeadlineType === 'date') {
    if (!e.deliveryDate) return false;
  } else if (e.deliveryDays === '' || Number.isNaN(Number(e.deliveryDays)) || Number(e.deliveryDays) < 0) {
    return false;
  }
  if (e.inspectionWindowHours !== '' && (Number.isNaN(Number(e.inspectionWindowHours)) || Number(e.inspectionWindowHours) < 1)) return false;
  return true;
}

/** `form_data` продажи целиком. `includeHouseholdPlot` — только у
 * `sale_personal` (у `sale_business` секции нет → unknown_field). */
export function buildSaleFormData(e: SaleEssence, includeHouseholdPlot: boolean): Record<string, unknown> {
  const needsAddress = saleNeedsAddress(e);
  return {
    category_code: e.categoryCode,
    item_name: e.itemName.trim(),
    item_description: e.itemDescription.trim(),
    condition: e.condition,
    ...(e.condition === 'used' ? { condition_defects_description: e.defects.trim() } : {}),
    ...(e.completeness.trim() ? { completeness: e.completeness.trim() } : {}),
    ...(e.categoryCode === 'electronics' ? { identifiers: e.identifiers.trim() } : {}),
    ...(includeHouseholdPlot ? { own_household_plot: e.ownHouseholdPlot } : {}),
    price: salePriceNormalized(e),
    delivery_type: e.deliveryType,
    ...(needsAddress ? { delivery_address: e.deliveryAddress.trim(), delivery_payer: e.deliveryPayer } : {}),
    delivery_deadline_type: e.deliveryDeadlineType,
    ...(e.deliveryDeadlineType === 'date' ? { delivery_date: e.deliveryDate } : { delivery_days: Number(e.deliveryDays) }),
    ...(e.deliveryType === 'transport_company' && e.trackingNumber.trim() ? { tracking_number: e.trackingNumber.trim() } : {}),
    ...(e.inspectionWindowHours !== '' ? { inspection_window_hours: Number(e.inspectionWindowHours) } : {}),
  };
}
