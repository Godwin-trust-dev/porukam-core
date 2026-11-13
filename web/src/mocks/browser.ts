import { setupWorker } from 'msw/browser';
import type { PushPermissionState } from '@porukam/core';
import { handlers } from './handlers';
import { debugSetVerificationLevel } from './profileDb';
import { debugClearAllNotifications, debugSetPushPermission, markAllRead } from './notificationsDb';

export const worker = setupWorker(...handlers);

/** Запуск мок-слоя (флаг VITE_API_MODE=mock). Переключение на реальный API — Ф6. */
export async function startMockApi(): Promise<void> {
  await worker.start({
    onUnhandledRequest: 'bypass',
    quiet: true,
  });

  // [Ф-решение] e2e-хук (DEV-02 §9.2): состояния, недостижимые через UI в скоупе
  // (ЕСИА-флоу — заглушка), — Playwright дергает window.__mockDebug напрямую,
  // без сети (MSW Service Worker не перехватывается Playwright page.route()).
  const { queryClient, i18n } = await import('../app/providers');
  (window as unknown as { __mockDebug?: Record<string, (...args: never[]) => void> }).__mockDebug = {
    setVerificationLevel: (level: number) => {
      debugSetVerificationLevel(level as 0 | 1 | 2 | 3);
      void queryClient.invalidateQueries({ queryKey: ['me'] });
    },
    // DEV-02 §9.2 → DEV-14: «важное» уведомление теперь — непрочитанное с severity: 'due'
    // (NextStepSlot в OwnerProfilePage). Прочитать всё эквивалентно снятию важности.
    clearImportantNotifications: () => {
      markAllRead();
      void queryClient.invalidateQueries({ queryKey: ['notifications'] });
    },
    clearAllNotifications: () => {
      debugClearAllNotifications();
      void queryClient.invalidateQueries({ queryKey: ['notifications'] });
    },
    setPushPermission: (state: PushPermissionState) => {
      debugSetPushPermission(state);
      void queryClient.invalidateQueries({ queryKey: ['notification-settings'] });
    },
    // DEV-16 §1 ⭐ — псевдолокаль (en-XA-подобная, packages/i18n/src/pseudo.ts): длинные
    // строки в скобках, для e2e-проверки, что вёрстка не переполняется/не обрезается.
    // Не выбираема через обычный UI-переключатель (нет в /v1/locales).
    setPseudoLocale: () => void i18n.changeLanguage('en-XA'),
    unsetPseudoLocale: () => void i18n.changeLanguage('en'),
  };
}
