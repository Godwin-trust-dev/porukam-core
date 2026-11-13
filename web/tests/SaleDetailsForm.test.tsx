import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import { createI18n } from '@porukam/i18n';
import { SaleDetailsForm } from '../src/pages/contract-new/SaleDetailsForm';
import { SALE_CATEGORY_CODES, type SaleEssence } from '../src/features/contractNew/saleFormData';

/**
 * Категории товара в продаже (2026-08-25): пользователь не нашёл «Продукты
 * питания» — список расширен восемью кодами, «Другое» остаётся последним.
 * Транспорт и недвижимость — не категории (special-типы, catalog-v2.md).
 */

const NEW_CODES = [
  'food',
  'pets',
  'auto_parts',
  'building_materials',
  'household',
  'jewelry_watches',
  'handmade_collectibles',
  'business_equipment',
] as const;

const essence: SaleEssence = {
  categoryCode: 'other',
  itemName: '',
  itemDescription: '',
  condition: 'new',
  defects: '',
  completeness: '',
  identifiers: '',
  ownHouseholdPlot: false,
  price: '',
  deliveryType: 'pickup',
  deliveryAddress: '',
  deliveryPayer: 'seller',
  deliveryDeadlineType: 'date',
  deliveryDate: '',
  deliveryDays: '',
  trackingNumber: '',
  inspectionWindowHours: '24',
};

function renderForm(): void {
  render(
    <I18nextProvider i18n={createI18n('ru')}>
      <SaleDetailsForm
        essence={essence}
        onChange={vi.fn()}
        showHouseholdPlot
        currency="RUB"
        onCurrencyChange={vi.fn()}
        paymentMethod=""
        onPaymentMethodChange={vi.fn()}
        paymentOrder=""
        onPaymentOrderChange={vi.fn()}
      />
    </I18nextProvider>,
  );
}

describe('SaleDetailsForm — категория товара', () => {
  it('select содержит все новые категории с переводами, «Другое» — последнее', () => {
    renderForm();
    const select = screen.getByTestId('sale-category') as HTMLSelectElement;
    const options = Array.from(select.options);
    const values = options.map((o) => o.value);

    expect(values).toEqual([...SALE_CATEGORY_CODES]);
    for (const code of NEW_CODES) expect(values).toContain(code);
    expect(values.at(-1)).toBe('other');

    const labelOf = (code: string): string =>
      options.find((o) => o.value === code)?.textContent ?? '';
    expect(labelOf('food')).toBe('Продукты питания');
    expect(labelOf('pets')).toBe('Животные и зоотовары');
    // Ни одна опция не показывает сырой ключ i18n.
    for (const o of options) expect(o.textContent).not.toMatch(/contractNew\./);
  });
});
