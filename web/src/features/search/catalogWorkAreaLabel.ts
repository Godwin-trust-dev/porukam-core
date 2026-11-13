import type { CatalogWorkArea } from '@porukam/core';
import { countryName } from '../groups/groupLabels';

/**
 * Подпись региона работы в строке каталожной выдачи (план 11.09 §6,
 * ADR-184/185) — СВОЯ, не `workAreaLabel` из
 * `features/profile/workAreaHelpers.ts`: форма `location` здесь другая
 * (`CatalogWorkAreaLocation` — без `name`/`name_latin`/`name_i18n`, только
 * `display_name`, см. комментарий в `@porukam/core/api/geo-types.ts`). После
 * приёмки 12.09 ключ страны (`code`) СОВПАДАЕТ с `GeoCountry`, но только для
 * `scope: 'country'` — у `region`/`city` alpha-2 страны лежит в `country`,
 * как и было (составной объект региона/города, а не сама страна). Показываем
 * ОДНО место (профиль может заявить до 5 — `apps.profiles.WorkArea`,
 * ADR-182 — но строка выдачи не обязана перечислять их все, вызывающая
 * сторона сама выбирает, какое показать).
 */
export function catalogWorkAreaLabel(area: CatalogWorkArea | undefined, lang: string, worldLabel: string): string {
  if (!area || area.scope === 'world' || !area.location) return worldLabel;
  if (area.scope === 'country') {
    return area.location.code ? countryName(area.location.code, lang) : worldLabel;
  }
  const country = area.location.country ? countryName(area.location.country, lang) : '';
  if (!area.location.display_name) return country;
  return country ? `${area.location.display_name}, ${country}` : area.location.display_name;
}
