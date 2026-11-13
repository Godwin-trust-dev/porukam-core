import { useState } from 'react';
import { useNotificationSettings, useUpdateNotificationSettings } from './api';
import {
  ensureBrowserPushSubscription,
  requestBrowserPushPermission,
  subscribeBrowserPush,
  unsubscribeBrowserPush,
  type DevicePushState,
  type PushSubscribeResult,
} from './push';
import { recordPushSubscribeResult } from './pushDeviceStore';
import { useDevicePushState } from './useDevicePushState';
import type { PushDeviceStatus } from './pushDeviceStatus';
import { useInstall } from '../pwa/useInstall';

export interface UsePushToggleResult {
  settings: ReturnType<typeof useNotificationSettings>['data'];
  isPending: boolean;
  pushDenied: boolean;
  needsIosGate: boolean;
  checked: boolean;
  onToggle: (next: boolean) => void;
  sheetOpen: boolean;
  setSheetOpen: (open: boolean) => void;
  confirm: () => Promise<void>;
  iosGateOpen: boolean;
  setIosGateOpen: (open: boolean) => void;
  /** Что происходит на ЭТОМ устройстве (ADR-175) — источник подсказки под тумблером. */
  device: DevicePushState | null;
  deviceStatus: PushDeviceStatus;
  lastSubscribeResult: PushSubscribeResult | null;
  /** Тумблер включён на сервере, а разрешения тут нет — «Включить на этом устройстве». */
  enableOnThisDevice: () => void;
  /** Разрешение есть, подписки нет — «Повторить» (системный диалог не показывается). */
  retrySubscribe: () => Promise<void>;
  retrying: boolean;
}

/**
 * Общая логика тумблера push (DEV-14 §6) + iOS-гейт (DEV-15 §5): переиспользуется
 * `NotificationsSettingsPage` и `AppSettingsPage` — один источник правды на обе поверхности.
 * На iOS вне standalone — вместо системного запроса открываем `IosInstallSheet`
 * (`iosGateOpen`); после установки на экран «Домой» тумблер работает как обычно.
 *
 * Тумблер показывает ЖЕЛАНИЕ пользователя (серверный `push`), подсказка под ним —
 * состояние ЭТОГО устройства (ADR-175). Разъезд этих двух вещей и был тихой
 * поломкой: серверный флаг стоит `true` по умолчанию, поэтому «включённый»
 * тумблер ничего не обещал, а разрешение на устройстве никто не спрашивал.
 */
export function usePushToggle(): UsePushToggleResult {
  const { data: settings, isPending } = useNotificationSettings();
  const update = useUpdateNotificationSettings();
  const install = useInstall();
  const device = useDevicePushState();
  const [sheetOpen, setSheetOpen] = useState(false);
  const [iosGateOpen, setIosGateOpen] = useState(false);
  const [retrying, setRetrying] = useState(false);

  // Отказ — свойство устройства, а не аккаунта: серверный `push_permission`
  // хранит ОДНО значение на человека, и отказ с другого устройства не должен
  // блокировать тумблер здесь. Серверный флаг оставлен фолбэком ровно для
  // случая, когда устройство ничего не может сказать о себе (`unsupported`).
  const pushDenied =
    device.state?.permission === 'denied' ||
    (device.state?.permission === 'unsupported' && settings?.push_permission === 'denied');
  const needsIosGate = install.isIos && !install.isStandalone;

  function openPermissionFlow(): void {
    if (needsIosGate) {
      setIosGateOpen(true);
      return;
    }
    setSheetOpen(true);
  }

  function onToggle(next: boolean): void {
    // Обёртка с нативным токеном (ADR-176): уведомления показывает приложение,
    // разрешение у него уже есть, а Web Push-подписки тут нет и быть не должно.
    // Тумблер в этом режиме управляет ТОЛЬКО серверным флагом «хочу push» —
    // системный запрос отсюда не показывается ни в ту, ни в другую сторону.
    if (device.state?.native) {
      update.mutate({ push: next });
      return;
    }
    if (!next) {
      update.mutate({ push: false });
      // Web Push подписка браузера снимается вместе с тумблером (ADR-110);
      // best effort — мёртвый endpoint бэк вычистит по 404/410 сам.
      void unsubscribeBrowserPush().then(() => device.refresh());
      return;
    }
    openPermissionFlow();
  }

  async function confirm(): Promise<void> {
    const result = await requestBrowserPushPermission();
    setSheetOpen(false);
    update.mutate({ push: result === 'granted', push_permission: result });
    // Реальная подписка (ADR-110) — после согласия. Её неудача не валит тумблер,
    // но и не пропадает молча: причина оседает в сторе и видна под тумблером.
    if (result === 'granted') {
      recordPushSubscribeResult(await subscribeBrowserPush());
    }
    device.refresh();
  }

  /** Разрешение уже выдано, а подписки нет — повтор БЕЗ системного диалога. */
  async function retrySubscribe(): Promise<void> {
    setRetrying(true);
    try {
      recordPushSubscribeResult(await ensureBrowserPushSubscription());
    } finally {
      setRetrying(false);
      device.refresh();
    }
  }

  return {
    settings,
    isPending,
    pushDenied,
    needsIosGate,
    checked: settings?.push ?? false,
    onToggle,
    sheetOpen,
    setSheetOpen,
    confirm,
    iosGateOpen,
    setIosGateOpen,
    device: device.state,
    deviceStatus: device.status,
    lastSubscribeResult: device.lastResult,
    enableOnThisDevice: openPermissionFlow,
    retrySubscribe,
    retrying,
  };
}
