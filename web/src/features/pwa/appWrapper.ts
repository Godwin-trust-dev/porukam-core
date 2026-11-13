/**
 * «Мы уже внутри установленного приложения» — признак обёртки (TWA из Play).
 *
 * Зачем отдельный модуль. Обёртка — это НЕ WebView: страница живёт в обычном
 * браузере телефона, и отличить её от вкладки того же браузера можно только по
 * косвенным признакам. Одного `display-mode: standalone` не хватило: 10.09
 * владелец поставила приложение из Play и внутри него увидела предложение
 * «скачать приложение» (*«я скачала приложение, но его не сразу сайт увидел, он
 * сначала предлагал мне скачать приложение»*). Часть сборок TWA отдаёт
 * `display-mode: browser`, а на Samsung Internet медиазапрос и вовсе врёт.
 *
 * Признаков поэтому три, и любой из них считается достаточным:
 *
 * 1. `document.referrer` начинается с `android-app://` — так браузер помечает
 *    переход из нативного приложения; у обычной вкладки такого реферера нет.
 *    Живёт только до первой перезагрузки внутри приложения — поэтому кэшируем.
 * 2. `?src=twa` в стартовом адресе — его подставляет сама обёртка. Параметр
 *    исчезает при первом же переходе по маршруту, так что момент, когда его
 *    видно, ровно один: старт (`captureAppWrapper` в `main.tsx`).
 * 3. `display-mode: standalone` / `navigator.standalone` — обычная установка
 *    на экран, тоже «приложение уже стоит».
 *
 * Первые два запоминаются в `sessionStorage`: они видны один раз за запуск, а
 * ответ нужен на каждой странице. Именно sessionStorage, а не localStorage:
 * признак описывает ЭТОТ запуск. Тот же телефон, открытый потом в браузере,
 * обязан снова видеть предложение установки — иначе человек, удаливший
 * приложение, никогда его не вернёт.
 */
const SESSION_KEY = 'porukam.appWrapper';

/** Имя и значение параметра стартового адреса — контракт с обёрткой (ADR-176). */
export const APP_WRAPPER_PARAM = 'src';
export const APP_WRAPPER_PARAM_VALUE = 'twa';

function readFlag(): boolean {
  try {
    return window.sessionStorage.getItem(SESSION_KEY) === '1';
  } catch {
    // Приватный режим/запрет хранилища — признак просто не переживёт переход.
    return false;
  }
}

function rememberFlag(): void {
  try {
    window.sessionStorage.setItem(SESSION_KEY, '1');
  } catch {
    // best effort
  }
}

/** Реферер `android-app://<package>` — переход из нативного приложения. */
function fromAndroidApp(): boolean {
  return typeof document !== 'undefined' && document.referrer.startsWith('android-app://');
}

/** `?src=twa` в текущем адресе — обёртка подставляет его в стартовый URL. */
function hasWrapperParam(): boolean {
  try {
    return new URL(window.location.href).searchParams.get(APP_WRAPPER_PARAM) === APP_WRAPPER_PARAM_VALUE;
  } catch {
    return false;
  }
}

/** Установленное приложение в своём окне (в том числе PWA с сайта и iOS «Домой»). */
function inStandaloneWindow(): boolean {
  const nav = navigator as Navigator & { standalone?: boolean };
  return Boolean(window.matchMedia?.('(display-mode: standalone)').matches) || nav.standalone === true;
}

/**
 * Снять признак со стартового адреса и запомнить его на запуск. Зовётся из
 * `main.tsx` до первого рендера: и реферер, и `?src=twa` доступны только там.
 */
export function captureAppWrapper(): boolean {
  if (typeof window === 'undefined') return false;
  if (readFlag()) return true;
  if (fromAndroidApp() || hasWrapperParam()) {
    rememberFlag();
    return true;
  }
  return false;
}

/**
 * Мы внутри установленного приложения. `standalone` проверяется КАЖДЫЙ раз и не
 * кэшируется: окно может сменить режим на ходу (`display-mode` — медиазапрос),
 * а вот признаки обёртки видны один раз и живут в сессии.
 */
export function isAppWrapper(): boolean {
  if (typeof window === 'undefined') return false;
  return captureAppWrapper() || inStandaloneWindow();
}
