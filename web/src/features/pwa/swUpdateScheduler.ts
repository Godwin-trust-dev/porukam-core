/**
 * Планировщик проверок обновления service worker (DEV-15 §4).
 *
 * Зачем он вообще нужен. `registerSW` из `vite-plugin-pwa` НЕ проверяет наличие новой сборки
 * сам — за новым `sw.js` браузер ходит только при НАВИГАЦИИ (полная загрузка документа) и,
 * по своему усмотрению, раз в сутки. На десктопе это незаметно: вкладку перезагружают руками,
 * проверка проходит, `onNeedRefresh` поднимает `UpdateToast`. На телефоне вкладка (и тем более
 * установленное с домашнего экрана приложение) неделями всплывает из фона БЕЗ навигации —
 * проверки не происходит, тост не показывается, человек сидит на старой сборке (жалоба
 * владельца 05.09: «на мобильном не предлагает обновить, на десктопе всё работает»).
 *
 * Поэтому проверку зовём сами: при возвращении приложения на передний план, по таймеру и при
 * возврате сети. Модуль намеренно не знает про `ServiceWorkerRegistration` — принимает
 * `update()` и часы, поэтому тестируется без живого SW (которого в jsdom нет).
 *
 * Все ошибки глотаются: проверка обновления — фон, она не имеет права уронить приложение
 * (та же тихая деградация, что у `onRegisterError` в `swRegistration.ts`).
 */

/**
 * Дребезг проверок «по возвращении на экран»: не чаще раза в 5 минут. Переключение между
 * приложениями на телефоне — событие частое (десятки раз в час), и без ограничения каждое
 * из них било бы запросом в сеть по мобильному трафику.
 */
export const SW_UPDATE_MIN_INTERVAL_MS = 5 * 60 * 1000;

/** Фоновая проверка раз в час — период из рецепта vite-plugin-pwa «periodic SW updates». */
export const SW_UPDATE_PERIOD_MS = 60 * 60 * 1000;

export interface SwUpdateSchedulerDeps {
  /** Собственно проверка — обычно `registration.update()`. */
  update: () => Promise<unknown>;
  /**
   * Адрес `sw.js`. Если задан — перед `update()` делаем предполётный запрос (см. `defaultProbe`):
   * при лежащем сервере (или отдающем HTML-страницу ошибки) звать `update()` бессмысленно.
   */
  swUrl?: string;
  /** Часы — подменяются в тестах. */
  now?: () => number;
  minIntervalMs?: number;
  periodMs?: number;
  isOnline?: () => boolean;
  isVisible?: () => boolean;
  /** Предполётный запрос: `false` → новую сборку не ищем. */
  probe?: (swUrl: string) => Promise<boolean>;
}

/**
 * Рецепт vite-plugin-pwa «periodic SW updates»: `sw.js` тянем мимо всех кэшей и считаем
 * сервер живым только на честном 200 (кэш/офлайн-фолбэк/страница ошибки прокси дадут
 * что угодно другое, и `update()` на них только зря разбудит SW).
 */
async function defaultProbe(swUrl: string): Promise<boolean> {
  const resp = await fetch(swUrl, {
    cache: 'no-store',
    headers: { cache: 'no-store', 'cache-control': 'no-cache' },
  });
  return resp.status === 200;
}

/**
 * Вешает слушатели и таймер; возвращает функцию остановки (снимает слушатели и таймер —
 * без неё повторная регистрация в dev/HMR оставляла бы за собой мёртвые интервалы).
 */
export function startSwUpdateScheduler(deps: SwUpdateSchedulerDeps): () => void {
  const {
    update,
    swUrl,
    now = () => Date.now(),
    minIntervalMs = SW_UPDATE_MIN_INTERVAL_MS,
    periodMs = SW_UPDATE_PERIOD_MS,
    isOnline = () => (typeof navigator === 'undefined' ? true : navigator.onLine !== false),
    isVisible = () => (typeof document === 'undefined' ? true : document.visibilityState === 'visible'),
    probe = defaultProbe,
  } = deps;

  // Регистрация SW сама только что сходила за `sw.js` — отсчёт дребезга начинаем от неё,
  // иначе первое же `visibilitychange` сразу после старта дало бы дублирующий запрос.
  let lastCheckAt = now();
  let stopped = false;

  async function check(): Promise<void> {
    if (stopped || !isOnline()) return;
    const at = now();
    if (at - lastCheckAt < minIntervalMs) return;
    // Отметку ставим ДО await'ов: две проверки, стартовавшие подряд (например
    // `visibilitychange` и `online` при выходе телефона из авиарежима), не должны
    // превратиться в два запроса.
    lastCheckAt = at;
    try {
      if (swUrl !== undefined && !(await probe(swUrl))) return;
      if (stopped) return;
      await update();
    } catch {
      // Тихая деградация: сеть, CORS, отозванная регистрация — тост просто не появится.
    }
  }

  function onVisibilityChange(): void {
    if (isVisible()) void check();
  }
  function onOnline(): void {
    void check();
  }

  document.addEventListener('visibilitychange', onVisibilityChange);
  window.addEventListener('online', onOnline);
  const timer = setInterval(() => void check(), periodMs);

  return () => {
    stopped = true;
    document.removeEventListener('visibilitychange', onVisibilityChange);
    window.removeEventListener('online', onOnline);
    clearInterval(timer);
  };
}
