import './styles/global.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App';
import { installChunkRecovery, recoverFromStaleChunk } from './app/chunkRecovery';
import { trackStandaloneOpen } from './features/analytics/installEvents';
import { captureNativePushToken } from './features/notifications/nativePushToken';
import { captureAppWrapper } from './features/pwa/appWrapper';
import { captureInstallPrompt } from './features/pwa/installPromptCapture';

async function bootstrap(): Promise<void> {
  // Ставим ПЕРВЫМ делом: чанк маршрута может не прийти на любом переходе, и
  // обработчик должен быть на месте раньше первого из них (01.09).
  installChunkRecovery();
  // Токен нативного пуша из стартового URL обёртки (ADR-176) — СИНХРОННО и
  // раньше всего, что смотрит на адрес: `push_token` — секрет устройства, и он
  // не должен ни остаться в адресной строке, ни уехать в реферер, ни попасть в
  // событие установки (ADR-171), которое отправляется ниже по этой функции.
  captureNativePushToken();
  // Признак «мы внутри установленного приложения» — тоже со стартового адреса
  // (`?src=twa`) и реферера: и то и другое исчезает при первом же переходе по
  // маршруту, а предложение установки не должно всплывать внутри самого
  // приложения (жалоба владельца 10.09).
  captureAppWrapper();
  // Тут же, СИНХРОННО и до первого `await`: Chromium стреляет `beforeinstallprompt` один
  // раз и рано, а до `createRoot().render()` ниже мы успеваем сходить за мок-слоем/SW и
  // языковым чанком. Слушатель внутри React-эффекта событие не заставал — и кнопка
  // установки навсегда оставалась мёртвой (05.09, Samsung S22 Ultra).
  captureInstallPrompt();
  // Мок-слой включается флагом окружения (ТЗ 3.3). По умолчанию в Ф1 — mock.
  //
  // Эта развилка — ЕДИНСТВЕННАЯ точка, решающая мок vs PWA-service-worker (DEV-15 §1):
  // MSW держит собственный SW на scope "/" для перехвата /v1/*, а Workbox-SW того же
  // scope не может работать одновременно с ним (два SW не делят контроль над fetch).
  // Поэтому пока VITE_API_MODE=mock — PWA SW не регистрируем вовсе (см. отчёт DEV-15);
  // как только Ф6 переключит флаг на реальный API, эта ветка станет боевой без правок.
  if ((import.meta.env.VITE_API_MODE ?? 'mock') === 'mock') {
    const { startMockApi } = await import('./mocks/browser');
    await startMockApi();
  } else {
    const { registerPwaSw } = await import('./features/pwa/swRegistration');
    registerPwaSw();

    // [Ф-решение] e2e-хук — ТОЛЬКО в выделенной сборке DEV-15 e2e/Lighthouse
    // (`npm run preview:pwa`, VITE_PWA_E2E=1), где нет ни MSW, ни реального бэкенда:
    // playwright.pwa.config.ts заводит сессию напрямую через стор, минуя OTP/Google.
    // В боевой Ф6-сборке этот флаг не выставляется — хук не попадает в бандл пользователя.
    if (import.meta.env.VITE_PWA_E2E === '1') {
      const { useAuthStore } = await import('./features/auth/authStore');
      // Мёржим, а не перезаписываем: registerPwaSw() мог уже (синхронно, если load успел
      // случиться раньше) положить сюда triggerNeedRefresh — плоское присваивание стёрло бы его.
      const w = window as unknown as { __pwaDebug?: Record<string, () => void> };
      w.__pwaDebug = {
        ...w.__pwaDebug,
        setAuthenticated: () => useAuthStore.getState().setTokens({ access: 'e2e', refresh: 'e2e' }),
      };
    }
  }
  // «Приложением пользуются» — раз в сутки на устройство (ADR-171). ПОСЛЕ
  // развилки мока/SW: в мок-режиме до старта MSW запрос ушёл бы в 404 и
  // насорил в консоли, а поведенческий слой не имеет права быть заметным.
  trackStandaloneOpen();
  // Языковой пакет первого кадра — ДО первого рендера (feat/l10n-launch-surfaces
  // §A, правило §0). 27 из 29 языков лежат ленивыми чанками (ADR-089), и без
  // этого ожидания стартовый экран успел бы отрисоваться по EN-фолбэку и через
  // мгновение перерисоваться на язык человека. Чанк ≈ 10 КБ и грузится
  // параллельно остальному бутстрапу; для `en`/`ru` (основной бандл) вызов
  // возвращается сразу, без сети.
  const { i18n } = await import('./app/providers');
  const { loadLocaleResources } = await import('@porukam/i18n');
  // Ошибку тут раньше глотали молча — и получали ровно то, что запрещает §0:
  // язык выбран, а весь текст по-английски (все ключи ушли в EN-фолбэк).
  // После деплоя это происходит у каждого, кто держал вкладку открытой:
  // имя чанка сменилось вместе с хешем. Пробуем перезагрузиться за свежей
  // оболочкой; если попытка уже была — рисуем как есть, но НЕ молча
  // (`chunkRecovery` объясняет ограничение одной попыткой).
  try {
    await loadLocaleResources(i18n, i18n.language);
  } catch {
    if (recoverFromStaleChunk()) return;
    console.warn(`[i18n] языковой пакет «${i18n.language}» не загрузился — интерфейс пойдёт по EN-фолбэку`);
  }

  const root = document.getElementById('root');
  if (!root) throw new Error('root not found');
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

void bootstrap();
