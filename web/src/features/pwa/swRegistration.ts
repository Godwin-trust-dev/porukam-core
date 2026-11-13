import { registerSW } from 'virtual:pwa-register';
import { usePwaStore } from './pwaStore';
import { startSwUpdateScheduler } from './swUpdateScheduler';

/** Остановка планировщика прошлой регистрации (dev/HMR зовут `register()` повторно). */
let stopUpdateScheduler: (() => void) | null = null;

/**
 * Регистрация PWA service worker (DEV-15 §1) — вызывается ТОЛЬКО из `main.tsx`, из ветки
 * `VITE_API_MODE !== 'mock'`. Это единственная точка развилки с мок-слоем: пока мок включён,
 * MSW держит контроль над fetch на scope "/", и Workbox-SW туда не пускаем — два service
 * worker'а не могут одновременно контролировать один scope (см. отчёт по DEV-15). Как только
 * Ф6 переключит `VITE_API_MODE` на реальный API, эта ветка станет боевой без правок кода.
 *
 * Регистрация — после `load` (§1); ошибка регистрации → тихая деградация (обычный сайт).
 */
function register(): void {
  try {
    const updateSW = registerSW({
      immediate: false,
      onNeedRefresh() {
        usePwaStore.getState().setNeedRefresh(true);
      },
      onOfflineReady() {
        usePwaStore.getState().setOfflineReady(true);
      },
      onRegisteredSW(swUrl, registration) {
        // Браузер сам ищет новый `sw.js` только при НАВИГАЦИИ. На десктопе владелец
        // перезагружает вкладку — проверка проходит, тост появляется; на телефоне вкладка
        // и установленное приложение всплывают из фона БЕЗ навигации, поэтому проверку
        // зовём сами (возврат на передний план / раз в час / возврат сети). См.
        // `swUpdateScheduler.ts` — там же дребезг и тихая деградация.
        if (!registration) return;
        stopUpdateScheduler?.();
        stopUpdateScheduler = startSwUpdateScheduler({
          swUrl,
          update: () => registration.update(),
        });
      },
      onRegisterError() {
        // Тихая деградация (§1) — сайт продолжает работать без офлайн-кэша/апдейт-тоста.
      },
    });
    usePwaStore.getState().setUpdateSW(updateSW);

    // [Ф-решение] e2e-хук (аналог `window.__mockDebug`, DEV-02 §9.2): Playwright триггерит
    // «доступна новая версия» напрямую — оркестровать реальный жизненный цикл waiting SW
    // в тесте медленно и флакует, а состояние `needRefresh` — единственное, что важно UI.
    // Мёржим, а не перезаписываем: `main.tsx` мог уже положить сюда `setAuthenticated`.
    const w = window as unknown as { __pwaDebug?: Record<string, () => void> };
    w.__pwaDebug = { ...w.__pwaDebug, triggerNeedRefresh: () => usePwaStore.getState().setNeedRefresh(true) };
  } catch {
    // Регистрация SW не удалась (старый браузер, ограничение окружения) — деградируем молча.
  }
}

export function registerPwaSw(): void {
  // `main.tsx` доходит сюда асинхронно (динамический импорт + await мок-развилки) — к этому
  // моменту `load` вполне может УЖЕ случиться (особенно в headless/e2e, где навигация ждёт
  // load сама); вешать addEventListener('load', …) вслепую в этом случае — упустить событие
  // навсегда и никогда не зарегистрировать SW. Проверяем readyState и догоняем, если опоздали.
  if (document.readyState === 'complete') {
    register();
  } else {
    window.addEventListener('load', register);
  }
}
