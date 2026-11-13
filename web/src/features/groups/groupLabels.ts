import type { GroupGeoScope, GroupKind } from '@porukam/core';

/** Подписи типов/географии объединения (ADR-117 §§1,3) — ключи `dashboard.*`.
 * Неизвестный код (легаси до миграции 0005, чужой бэк) — дефолт `clan`. */
export const GROUP_KINDS: readonly GroupKind[] = ['guild', 'clan', 'community', 'company_showcase'];

export function groupKindLabelKey(kind: string): string {
  switch (kind) {
    case 'guild':
      return 'dashboard.groupKindGuild';
    case 'community':
      return 'dashboard.groupKindCommunity';
    case 'company_showcase':
    case 'company_storefront':
      return 'dashboard.groupKindCompany';
    default:
      return 'dashboard.groupKindClan';
  }
}

/** Подсказка «?» у типа — тексты из книги (trust_economy/Block IV, гл. 14). */
export function groupKindHintKey(kind: GroupKind): string {
  switch (kind) {
    case 'guild':
      return 'dashboard.groupKindHintGuild';
    case 'community':
      return 'dashboard.groupKindHintCommunity';
    case 'company_showcase':
      return 'dashboard.groupKindHintCompany';
    default:
      return 'dashboard.groupKindHintClan';
  }
}

export const GROUP_GEO_SCOPES: readonly GroupGeoScope[] = ['world', 'country', 'city'];

export function groupGeoLabelKey(scope: GroupGeoScope): string {
  return scope === 'world' ? 'dashboard.groupGeoWorld' : scope === 'country' ? 'dashboard.groupGeoCountry' : 'dashboard.groupGeoCity';
}

/**
 * Страны для выбора географии — ISO 3166-1 alpha-2, как `User.country_code`.
 * Имена — `Intl.DisplayNames` на языке интерфейса (нативная локализация, без
 * 29 словарей); фолбэк — сам код. Список — рынки запуска + крупные страны;
 * расширяется здесь одной строкой.
 */
export const COUNTRY_CODES: readonly string[] = [
  'RU', 'KZ', 'BY', 'UA', 'UZ', 'KG', 'TJ', 'TM', 'AM', 'AZ', 'GE', 'MD',
  'TR', 'AE', 'IL', 'IR', 'SA', 'EG',
  'DE', 'FR', 'IT', 'ES', 'PT', 'PL', 'RO', 'CZ', 'NL', 'BE', 'AT', 'CH', 'GB', 'IE', 'SE', 'NO', 'FI', 'DK', 'GR', 'RS', 'BG', 'HU', 'LT', 'LV', 'EE',
  'US', 'CA', 'MX', 'BR', 'AR', 'CL', 'CO',
  'IN', 'PK', 'BD', 'ID', 'VN', 'TH', 'MY', 'SG', 'PH', 'JP', 'KR', 'CN', 'AU', 'NZ',
  'KE', 'TZ', 'NG', 'ZA',
];

export function countryName(code: string, lang: string): string {
  if (!code) return '';
  try {
    const names = new Intl.DisplayNames([lang], { type: 'region' });
    return names.of(code) ?? code;
  } catch {
    return code;
  }
}

/** Человекочитаемая география карточки: «Весь мир» / «Казахстан» / «Алматы, Казахстан». */
export function geoSummary(
  group: { geo_scope: GroupGeoScope; country_code: string; city_name: string },
  lang: string,
  worldLabel: string,
): string {
  if (group.geo_scope === 'world') return worldLabel;
  const country = countryName(group.country_code, lang);
  if (group.geo_scope === 'country') return country;
  return [group.city_name, country].filter(Boolean).join(', ');
}
