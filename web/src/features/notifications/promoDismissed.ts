/**
 * «✕» на PushPromo — «запомнить локально» (DEV-14 §3): чисто клиентский выбор,
 * не часть `NotificationSettings` на бэке (тот же приём, что `cookieChoice.ts`).
 */
const KEY = 'porukam.pushPromoDismissed';

export function isPushPromoDismissed(): boolean {
  return localStorage.getItem(KEY) === '1';
}

export function dismissPushPromo(): void {
  localStorage.setItem(KEY, '1');
}
