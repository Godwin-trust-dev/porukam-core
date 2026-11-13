import { create } from 'zustand';
import type { PushSubscribeResult } from './push';

interface PushDeviceStoreState {
  /**
   * Результат последней попытки подписки В ЭТОЙ вкладке. Сверка при входе
   * (`usePushResubscribe`) отрабатывает в оболочке, а показать её неудачу надо
   * в настройках — стор и есть этот канал (тот же приём, что `pwaStore` для
   * регистрации service worker'а).
   */
  lastSubscribeResult: PushSubscribeResult | null;
  setLastSubscribeResult: (result: PushSubscribeResult | null) => void;
}

export const usePushDeviceStore = create<PushDeviceStoreState>((set) => ({
  lastSubscribeResult: null,
  setLastSubscribeResult: (result) => set({ lastSubscribeResult: result }),
}));

/** Запомнить исход попытки: успех стирает прежнюю жалобу, неудача — заменяет. */
export function recordPushSubscribeResult(result: PushSubscribeResult): void {
  usePushDeviceStore.getState().setLastSubscribeResult(result.ok ? null : result);
}
