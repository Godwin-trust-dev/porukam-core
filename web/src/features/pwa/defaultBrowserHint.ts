/**
 * Подсказка «сделайте Chrome браузером по умолчанию».
 *
 * Обёртка TWA открывает страницу в браузере по умолчанию, и на Samsung это
 * Samsung Internet. От выбора браузера зависят ровно те две вещи, на которые
 * жаловался владелец 10.09: Samsung Internet сам инвертирует палитру («тёмный
 * режим сайтов») и не отдаёт приложению делегированные уведомления — доставку
 * из TWA сегодня умеет только Chrome. Проверено там же: заставить обёртку
 * открываться в Chrome кодом НЕ получается — выбор браузера принадлежит
 * системе. Значит остаётся сказать это человеку словами и довести до нужного
 * экрана настроек (владелец: «единственное, что работает — установка браузера
 * по умолчанию Chrome; мы должны предлагать людям и давать ссылку на смену
 * браузера»).
 *
 * Скрывается навсегда — тем же приёмом, что промо-полоса push
 * (`promoDismissed.ts`): это клиентский выбор, а не часть настроек аккаунта.
 */
import { isAppWrapper } from './appWrapper';

const KEY = 'porukam.defaultBrowserHintDismissed';

/**
 * Системный экран «Приложения по умолчанию». `intent://` понимает только
 * Android-браузер; на всём остальном ссылка просто не сработает — поэтому
 * рядом с кнопкой ВСЕГДА стоит текстовый путь до того же экрана.
 */
export const DEFAULT_APPS_INTENT =
  'intent://settings/#Intent;action=android.settings.MANAGE_DEFAULT_APPS_SETTINGS;end';

export function isDefaultBrowserHintDismissed(): boolean {
  try {
    return localStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
}

export function dismissDefaultBrowserHint(): void {
  try {
    localStorage.setItem(KEY, '1');
  } catch {
    // Приватный режим — подсказка вернётся при следующем запуске, это не поломка.
  }
}

/**
 * Мы внутри приложения, но НЕ в Chrome.
 *
 * Samsung Internet проверяется отдельно и первым: его строка UA содержит
 * `Chrome/` (он на Chromium), и по одному этому признаку он сошёл бы за Chrome.
 * Второй случай — браузер без `Chrome/` вовсе (Firefox и прочие): там
 * делегированных уведомлений тоже нет.
 */
export function isNonChromeWrapper(): boolean {
  if (typeof navigator === 'undefined') return false;
  if (!isAppWrapper()) return false;
  const ua = navigator.userAgent;
  return ua.includes('SamsungBrowser') || !ua.includes('Chrome/');
}

/** Показывать ли плашку: не в Chrome, внутри приложения и ещё не скрыта навсегда. */
export function shouldShowDefaultBrowserHint(): boolean {
  return isNonChromeWrapper() && !isDefaultBrowserHintDismissed();
}

/**
 * Открыть системный экран выбора приложений по умолчанию. `false` — переход не
 * состоялся (браузер не понимает `intent://` или запретил навигацию); UI из-за
 * этого не меняется: текстовая инструкция и так на экране.
 */
export function openDefaultAppsSettings(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    window.location.assign(DEFAULT_APPS_INTENT);
    return true;
  } catch {
    return false;
  }
}
