import { describe, expect, it } from 'vitest';
import { EXPERIENCE_OPTIONS, nearestLowerExperiencePreset } from '../src/features/search/api';
import { WORLD_GEO_FILTER, widenGeoFilter, type GeoFilter } from '../src/features/search/geoFilter';

/**
 * Чистые функции разбора пустой выдачи каталога (план 11.09 §7, ADR-187):
 * гео-фильтр на один уровень шире и ближайший меньший пресет опыта.
 * Полное поведение хука (`useCatalogEmptySuggestion`, приоритет проб,
 * реакция кнопок) — `SearchCatalogEmptyStates.test.tsx`.
 */
describe('widenGeoFilter — гео-фильтр на один уровень шире', () => {
  it('город → регион (регион известен): снимает только город', () => {
    const filter: GeoFilter = { country: 'RU', region: 'RU-MOS', city: 1 };
    expect(widenGeoFilter(filter)).toEqual({ country: 'RU', region: 'RU-MOS', city: null });
  });

  it('город без известного региона → сразу страна (второго уровня фильтр не хранит)', () => {
    const filter: GeoFilter = { country: 'RU', region: null, city: 1 };
    expect(widenGeoFilter(filter)).toEqual({ country: 'RU', region: null, city: null });
  });

  it('регион (без города) → страна', () => {
    const filter: GeoFilter = { country: 'KZ', region: 'KZ-ALM', city: null };
    expect(widenGeoFilter(filter)).toEqual({ country: 'KZ', region: null, city: null });
  });

  it('страна (без региона/города) → весь мир', () => {
    const filter: GeoFilter = { country: 'KZ', region: null, city: null };
    expect(widenGeoFilter(filter)).toEqual(WORLD_GEO_FILTER);
  });

  it('уже весь мир — no-op (шире некуда)', () => {
    expect(widenGeoFilter(WORLD_GEO_FILTER)).toEqual(WORLD_GEO_FILTER);
  });
});

describe('nearestLowerExperiencePreset — ближайший МЕНЬШИЙ порог опыта', () => {
  it('пресеты панели — 1/3/5/10 (порядок роста)', () => {
    expect(EXPERIENCE_OPTIONS).toEqual([1, 3, 5, 10]);
  });

  it.each([
    [10, 5],
    [5, 3],
    [3, 1],
  ])('текущий пресет %i → следующий меньший пресет %i', (current, expected) => {
    expect(nearestLowerExperiencePreset(current)).toBe(expected);
  });

  it('минимальный пресет (1) — снижать больше некуда, «любой опыт» (null)', () => {
    expect(nearestLowerExperiencePreset(1)).toBeNull();
  });

  it('нестандартное значение (ручная правка URL) — ближайший пресет СТРОГО МЕНЬШЕ него', () => {
    expect(nearestLowerExperiencePreset(7)).toBe(5);
    expect(nearestLowerExperiencePreset(2)).toBe(1);
  });
});
