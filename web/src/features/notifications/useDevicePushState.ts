import { useCallback, useEffect, useState } from 'react';
import { getDevicePushState, type DevicePushState, type PushSubscribeResult } from './push';
import { devicePushStatus, type PushDeviceStatus } from './pushDeviceStatus';
import { usePushDeviceStore } from './pushDeviceStore';

export interface UseDevicePushStateResult {
  /** `null` — ещё не прочитано (статус `loading`). */
  state: DevicePushState | null;
  status: PushDeviceStatus;
  /** Последняя неудачная попытка подписки в этой вкладке (ADR-175). */
  lastResult: PushSubscribeResult | null;
  /** Перечитать состояние устройства — после запроса разрешения и после «Повторить». */
  refresh: () => void;
}

/**
 * Состояние push на ЭТОМ устройстве для интерфейса. Читается только у браузера
 * (`Notification.permission` + `pushManager.getSubscription()`), сервер сюда не
 * участвует: его `push`/`push_permission` — про аккаунт целиком (ADR-175).
 *
 * Не react-query: сетевого запроса тут нет вовсе, а перечитывать надо ровно в
 * три момента — маунт, ответ на системный диалог, ручной повтор подписки.
 */
export function useDevicePushState(): UseDevicePushStateResult {
  const [state, setState] = useState<DevicePushState | null>(null);
  const [nonce, setNonce] = useState(0);
  const lastResult = usePushDeviceStore((s) => s.lastSubscribeResult);

  useEffect(() => {
    let cancelled = false;
    void getDevicePushState().then((next) => {
      if (!cancelled) setState(next);
    });
    return () => {
      cancelled = true;
    };
  }, [nonce]);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  return { state, status: devicePushStatus(state), lastResult, refresh };
}
