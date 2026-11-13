/** Старый флаг «закрыто НАВСЕГДА» (значение `'1'`) — мигрируется при первом чтении. */
const LEGACY_DISMISSED_KEY = 'porukam.installBannerDismissed';
const DISMISSED_AT_KEY = 'porukam.installBannerDismissedAt';
const INSTALLED_KEY = 'porukam.appInstalled';

/**
 * «✕» на баннере установки = ОТЛОЖИТЬ на неделю, а не отказаться навсегда (решение владельца
 * 05.09). Раньше одно касание крестика убирало предложение установить приложение до конца
 * жизни браузерного профиля — а предложение нужно ровно тем, кто ещё не поставил.
 */
export const INSTALL_BANNER_SNOOZE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Момент последнего закрытия баннера. Здесь же — одноразовая миграция старого флага: у кого
 * он стоял, отсчёт недели начинается с ПЕРВОГО чтения после обновления (человек увидит
 * предложение снова через 7 дней, а не мгновенно — иначе обновление выглядело бы как
 * «баннер, который я закрыл, вернулся сам»).
 */
function dismissedAt(now: number): number | null {
  let raw = localStorage.getItem(DISMISSED_AT_KEY);
  if (raw === null && localStorage.getItem(LEGACY_DISMISSED_KEY) === '1') {
    raw = String(now);
    localStorage.setItem(DISMISSED_AT_KEY, raw);
    localStorage.removeItem(LEGACY_DISMISSED_KEY);
  }
  if (raw === null) return null;
  const at = Number(raw);
  return Number.isFinite(at) ? at : null;
}

/** Баннер установки отложен, и неделя ещё не вышла (DEV-15 §2). */
export function isInstallDismissed(now: number = Date.now()): boolean {
  const at = dismissedAt(now);
  return at !== null && now - at < INSTALL_BANNER_SNOOZE_MS;
}

export function dismissInstall(now: number = Date.now()): void {
  localStorage.setItem(DISMISSED_AT_KEY, String(now));
  localStorage.removeItem(LEGACY_DISMISSED_KEY);
}

/**
 * Флаг «приложение установлено» (`appinstalled`) — ОТДЕЛЬНО от `dismissed` и, в отличие от
 * него, ПОСТОЯННЫЙ: закрытие баннера крестиком не значит «установлено», а установка не значит
 * «баннер отложен по желанию». Персистится, потому что `matchMedia('display-mode: standalone')`
 * не станет `true` в ЭТОЙ вкладке-браузере сразу после `appinstalled` (установленное
 * приложение — отдельное окно) — без флага «Установлено» в настройках показалось бы
 * неустановленным на следующей странице.
 */
export function isMarkedInstalled(): boolean {
  return localStorage.getItem(INSTALLED_KEY) === '1';
}

export function markInstalled(): void {
  localStorage.setItem(INSTALLED_KEY, '1');
}
