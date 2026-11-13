import { useAuthStore } from '../auth/authStore';

/**
 * Воронка установки приложения — ВТОРОЙ и последний ввод аналитики (ADR-171).
 *
 * Заведён потому, что установка иначе неизмерима вовсе: `beforeinstallprompt`
 * и `appinstalled` живут в браузере и никуда не уходят, а Play Console видит
 * только то, что случилось уже в магазине. Доменного события «поставил
 * приложение» нет и быть не должно — приложение ничего не утверждает о сделке.
 *
 * Что уходит на сервер: вид события, грубая корзина платформы, режим показа и
 * источник. И всё. Ни User-Agent (строка UA опознаёт устройство точнее, чем
 * нужно ответу «сколько установок»), ни IP, ни отпечатка, ни идентификатора
 * сессии. Пользователь берётся сервером ИЗ ТОКЕНА, а не из тела запроса —
 * иначе установку можно было бы приписать чужому аккаунту.
 *
 * Отправка не имеет права мешать человеку ставить приложение: `keepalive`,
 * ошибки проглатываются молча, ответ не ожидается.
 */
export type InstallEventKind =
  | 'install_prompt_shown'
  | 'install_click'
  | 'pwa_installed'
  | 'play_click'
  | 'standalone_open';

type Platform = 'android' | 'ios' | 'desktop' | 'other';
type DisplayMode = 'browser' | 'standalone';
type Source = 'site' | 'play' | 'unknown';

/** Ключ дедупликации `standalone_open`: считаем раз в сутки на устройство. */
const STANDALONE_DAY_KEY = 'porukam.installAnalytics.standaloneDay';

/**
 * Грубая корзина платформы из UA. Именно грубая: три значения плюс «прочее» —
 * это подсказка «где чинить установку», а не описание устройства. Сама строка
 * UA не покидает браузер.
 */
export function detectPlatform(): Platform {
  if (typeof navigator === 'undefined') return 'other';
  const ua = navigator.userAgent;
  if (/android/i.test(ua)) return 'android';
  // iPadOS 13+ представляется Macintosh, но имеет тачскрин — тот же приём,
  // что в useInstall.detectIos(): иначе все айпады попадут в «десктоп».
  if (/iphone|ipad|ipod/i.test(ua) || (ua.includes('Macintosh') && navigator.maxTouchPoints > 1)) {
    return 'ios';
  }
  if (/windows|macintosh|linux|cros/i.test(ua) && !/mobile/i.test(ua)) return 'desktop';
  return 'other';
}

/** Открыто как приложение (отдельное окно / TWA) или как вкладка браузера. */
export function detectDisplayMode(): DisplayMode {
  if (typeof window === 'undefined') return 'browser';
  const nav = navigator as Navigator & { standalone?: boolean };
  const media = Boolean(window.matchMedia?.('(display-mode: standalone)').matches);
  // TWA из Google Play не даёт `display-mode: standalone` в части сборок, но
  // всегда приходит с реферером `android-app://` — это тот же случай «человек
  // пользуется установленным приложением».
  const twa = typeof document !== 'undefined' && document.referrer.startsWith('android-app://');
  return media || nav.standalone === true || twa ? 'standalone' : 'browser';
}

/**
 * Откуда пришло приложение. `android-app://` в реферере — запуск из TWA, то
 * есть установка была из Google Play; всё остальное, что открыто в режиме
 * приложения, поставлено с сайта. Обычная вкладка источника не знает и врать
 * о нём не должна — `unknown`.
 */
export function detectSource(): Source {
  if (typeof document !== 'undefined' && document.referrer.startsWith('android-app://')) {
    return 'play';
  }
  return detectDisplayMode() === 'standalone' ? 'site' : 'unknown';
}

/**
 * Отправка события. `fetch` с `keepalive`, а не `sendBeacon`: маячок не умеет
 * ставить заголовки, а без `Authorization` установка авторизованного человека
 * навсегда осталась бы гостевой — и не сложилась бы с остальной жизнью его
 * аккаунта. `keepalive` даёт то же главное свойство, что и маячок: запрос
 * переживает уход со страницы.
 */
export function trackInstallEvent(kind: InstallEventKind): void {
  if (typeof fetch === 'undefined') return;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  try {
    const token = useAuthStore.getState().access;
    if (token) headers.Authorization = `Bearer ${token}`;
  } catch {
    /* стор ещё не поднят — отправляем как гость, это допустимый случай */
  }
  void fetch('/v1/analytics/install-event', {
    method: 'POST',
    keepalive: true,
    headers,
    body: JSON.stringify({
      kind,
      platform: detectPlatform(),
      display_mode: detectDisplayMode(),
      source: detectSource(),
    }),
  }).catch(() => {
    /* аналитика не имеет права ломать установку — молчим */
  });
}

/**
 * «Человек пользуется установленным приложением» — раз в сутки на устройство.
 *
 * Дедуп именно суточный и именно в localStorage: без него метрика считала бы
 * не людей, а переходы по страницам, а любой более точный счёт потребовал бы
 * отпечатка устройства, которого мы не снимаем (ADR-171). Ключ виден только
 * этому браузеру и никуда не уходит.
 */
export function trackStandaloneOpen(now: Date = new Date()): boolean {
  if (detectDisplayMode() !== 'standalone') return false;
  const today = now.toISOString().slice(0, 10);
  try {
    if (localStorage.getItem(STANDALONE_DAY_KEY) === today) return false;
    localStorage.setItem(STANDALONE_DAY_KEY, today);
  } catch {
    // Приватный режим/запрет хранилища: отправляем без дедупа — потеря
    // точности честнее, чем молчание об использовании приложения.
  }
  trackInstallEvent('standalone_open');
  return true;
}
