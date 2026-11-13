import { describe, expect, it } from 'vitest';
import {
  SALE_CATEGORY_CODES,
  buildSaleFormData,
  saleComplete,
  saleFromFormData,
  salePriceNormalized,
  type SaleEssence,
} from '../src/features/contractNew/saleFormData';

/** Сборка form_data продажи под SALE_*_SCHEMA (отсмотр 2026-08-20) —
 * условные поля уходят только когда видимы, иначе сервер даёт 422. */

const base: SaleEssence = {
  categoryCode: 'furniture_interior',
  itemName: 'Диван угловой',
  itemDescription: 'Серый, 2 года',
  condition: 'new',
  defects: '',
  completeness: '',
  identifiers: '',
  ownHouseholdPlot: false,
  price: '45 000,50',
  deliveryType: 'pickup',
  deliveryAddress: '',
  deliveryPayer: 'seller',
  deliveryDeadlineType: 'date',
  deliveryDate: '2026-09-01',
  deliveryDays: '',
  trackingNumber: '',
  inspectionWindowHours: '24',
};

describe('saleFormData', () => {
  it('SALE_CATEGORY_CODES: новые категории (food и др.) присутствуют, other — последний', () => {
    for (const code of ['food', 'pets', 'auto_parts', 'building_materials', 'household', 'jewelry_watches', 'handmade_collectibles', 'business_equipment']) {
      expect(SALE_CATEGORY_CODES).toContain(code);
    }
    expect(SALE_CATEGORY_CODES.at(-1)).toBe('other');
    expect(new Set(SALE_CATEGORY_CODES).size).toBe(SALE_CATEGORY_CODES.length);
    // Неизвестный код из form_data не ломает форму — падает в 'other'.
    expect(saleFromFormData({ category_code: 'vehicles' }).categoryCode).toBe('other');
    expect(saleFromFormData({ category_code: 'food' }).categoryCode).toBe('food');
  });

  it('минимальная форма (самовывоз, новый) — только обязательные ключи, цена нормализована', () => {
    expect(saleComplete(base)).toBe(true);
    expect(salePriceNormalized(base)).toBe('45000.50');
    expect(buildSaleFormData(base, true)).toEqual({
      category_code: 'furniture_interior',
      item_name: 'Диван угловой',
      item_description: 'Серый, 2 года',
      condition: 'new',
      own_household_plot: false,
      price: '45000.50',
      delivery_type: 'pickup',
      delivery_deadline_type: 'date',
      delivery_date: '2026-09-01',
      inspection_window_hours: 24,
    });
    // sale_business: секции household_plot нет → ключ не отправляется (unknown_field)
    expect(buildSaleFormData(base, false)).not.toHaveProperty('own_household_plot');
  });

  it('б/у требует дефекты; электроника — идентификаторы; курьер — адрес и плательщика', () => {
    expect(saleComplete({ ...base, condition: 'used' })).toBe(false);
    expect(saleComplete({ ...base, condition: 'used', defects: 'царапина' })).toBe(true);
    expect(saleComplete({ ...base, categoryCode: 'electronics' })).toBe(false);
    expect(saleComplete({ ...base, categoryCode: 'electronics', identifiers: 'S/N 1' })).toBe(true);
    expect(saleComplete({ ...base, deliveryType: 'courier' })).toBe(false);
    const courier: SaleEssence = { ...base, deliveryType: 'courier', deliveryAddress: 'Москва', deliveryPayer: 'buyer' };
    expect(saleComplete(courier)).toBe(true);
    expect(buildSaleFormData(courier, false)).toMatchObject({
      delivery_type: 'courier',
      delivery_address: 'Москва',
      delivery_payer: 'buyer',
    });
    // трек-номер — только у транспортной компании
    expect(buildSaleFormData({ ...courier, trackingNumber: 'X1' }, false)).not.toHaveProperty('tracking_number');
    expect(buildSaleFormData({ ...courier, deliveryType: 'transport_company', trackingNumber: 'X1' }, false)).toMatchObject({ tracking_number: 'X1' });
  });

  it('срок «дней после оплаты» → delivery_days числом, без delivery_date', () => {
    const rel: SaleEssence = { ...base, deliveryDeadlineType: 'relative_to_payment', deliveryDate: '', deliveryDays: '3' };
    expect(saleComplete({ ...rel, deliveryDays: '' })).toBe(false);
    expect(buildSaleFormData(rel, false)).toMatchObject({ delivery_deadline_type: 'relative_to_payment', delivery_days: 3 });
    expect(buildSaleFormData(rel, false)).not.toHaveProperty('delivery_date');
  });

  it('round-trip: form_data сервера → форма → тот же form_data', () => {
    const fd = buildSaleFormData({ ...base, condition: 'used', defects: 'скол', completeness: 'коробка' }, true);
    expect(buildSaleFormData(saleFromFormData(fd), true)).toEqual(fd);
  });
});
