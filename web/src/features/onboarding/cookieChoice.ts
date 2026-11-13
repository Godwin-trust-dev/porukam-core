/**
 * Выбор cookie-баннера (§3 DEV-auth-onboarding, privacy-first): по умолчанию
 * действуют только необходимые БЕЗ клика — явное действие («Принять все» /
 * «Только необходимые») сохраняем отдельно от факта показа.
 *
 * Отсмотр 2026-08-24: «сообщение про куки человек должен видеть 1 раз» —
 * раньше баннер висел до явного клика и возвращался при каждой загрузке.
 * Теперь первый показ фиксируется сам (markCookieBannerShown), и без клика
 * продолжает действовать дефолт «только необходимые» — приватность по
 * умолчанию не требует от человека никакого действия.
 */
const KEY = 'porukam.cookieChoice';
const SHOWN_KEY = 'porukam.cookieBannerShown';

export type CookieChoice = 'all' | 'necessary';

export function getCookieChoice(): CookieChoice | null {
  const raw = localStorage.getItem(KEY);
  return raw === 'all' || raw === 'necessary' ? raw : null;
}

export function setCookieChoice(choice: CookieChoice): void {
  localStorage.setItem(KEY, choice);
}

export function wasCookieBannerShown(): boolean {
  return localStorage.getItem(SHOWN_KEY) === '1';
}

export function markCookieBannerShown(): void {
  localStorage.setItem(SHOWN_KEY, '1');
}
