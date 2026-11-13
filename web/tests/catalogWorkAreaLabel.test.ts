import { describe, expect, it } from 'vitest';
import type { CatalogWorkArea } from '@porukam/core';
import { catalogWorkAreaLabel } from '../src/features/search/catalogWorkAreaLabel';

/**
 * Подпись региона работы в каталожной выдаче (план 11.09 §6, ADR-184/185) —
 * форма `location` ПОСЛЕ приёмки 12.09 (`26abc882`): страна ключом `code`
 * (как везде в `apps.geo`/`work-areas`), у региона/города alpha-2 страны —
 * ключом `country` (составной объект, а не сама страна).
 */
describe('catalogWorkAreaLabel', () => {
  const world = 'Весь мир';

  it('scope: world или отсутствующий регион → подпись «весь мир»', () => {
    const area: CatalogWorkArea = { scope: 'world', location: null };
    expect(catalogWorkAreaLabel(area, 'ru', world)).toBe(world);
    expect(catalogWorkAreaLabel(undefined, 'ru', world)).toBe(world);
  });

  it('scope: country — читает alpha-2 из `location.code`, а не `location.country`', () => {
    const area: CatalogWorkArea = { scope: 'country', location: { code: 'KZ' } };
    expect(catalogWorkAreaLabel(area, 'ru', world)).toBe('Казахстан');
  });

  it('scope: country без `code` (испорченные данные) — фолбэк «весь мир», не пустая строка', () => {
    const area: CatalogWorkArea = { scope: 'country', location: {} };
    expect(catalogWorkAreaLabel(area, 'ru', world)).toBe(world);
  });

  it('scope: region — «регион, страна» из `location.country` (не `code`)', () => {
    const area: CatalogWorkArea = {
      scope: 'region',
      location: { code: 'KZ-ALM', country: 'KZ', display_name: 'Алматинская область' },
    };
    expect(catalogWorkAreaLabel(area, 'ru', world)).toBe('Алматинская область, Казахстан');
  });

  it('scope: city — «город, страна»', () => {
    const area: CatalogWorkArea = {
      scope: 'city',
      location: { id: 3, country: 'KZ', region: 'KZ-ALM', display_name: 'Алматы', population: 2_000_000 },
    };
    expect(catalogWorkAreaLabel(area, 'ru', world)).toBe('Алматы, Казахстан');
  });
});
