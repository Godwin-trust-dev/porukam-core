import { trackInstallEvent } from '../analytics/installEvents';
import { usePwaStore, type BeforeInstallPromptEvent } from './pwaStore';

/**
 * Ранний перехват `beforeinstallprompt` (DEV-15 §2).
 *
 * Chromium стреляет это событие ОДИН раз и очень рано — как только браузер убедился, что
 * манифест и service worker на месте. `main.tsx` до первого рендера успевает сделать
 * несколько `await` (мок-слой либо регистрация SW, затем языковой чанк), поэтому React
 * монтирует `ShellLayout` уже ПОСЛЕ выстрела. Слушатель, который вешал `useInstall` в своём
 * `useEffect`, событие не заставал — оно не повторяется, и кнопка установки навсегда
 * оставалась мёртвой (жалоба владельца 05.09: Samsung S22 Ultra, строка «Установить
 * приложение» не реагирует на нажатие).
 *
 * Поэтому слушатель ставится синхронно на старте бутстрапа, а событие кладётся в
 * `pwaStore` — React читает уже готовое значение, когда бы он ни смонтировался.
 */
let started = false;

export function captureInstallPrompt(): void {
  if (started || typeof window === 'undefined') return;
  started = true;

  window.addEventListener('beforeinstallprompt', (e) => {
    // Без preventDefault Chrome покажет собственную мини-панель — установка должна
    // происходить по нашей кнопке, в момент, который человек выбрал сам (§2).
    e.preventDefault();
    usePwaStore.getState().setInstallPrompt(e as BeforeInstallPromptEvent);
  });

  window.addEventListener('appinstalled', () => {
    usePwaStore.getState().setInstallPrompt(null);
    // Единственный момент, когда браузер сам сообщает об установке (ADR-171).
    // Слушатель стоит ЗДЕСЬ, а не в React-эффекте, по той же причине, что и
    // соседний: событие одноразовое, и хук его может не застать.
    trackInstallEvent('pwa_installed');
  });
}
