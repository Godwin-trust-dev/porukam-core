import { useEffect } from 'react';
import { useNotificationSettings } from './api';
import { getNativePushState } from './nativePushToken';
import { ensureBrowserPushSubscription, getBrowserPushPermission, waitForServiceWorkerReady } from './push';
import { recordPushSubscribeResult } from './pushDeviceStore';

/**
 * Сверка Web Push подписки при входе в оболочку (ADR-110, отсмотр 2026-08-27):
 * тумблер включён + разрешение `granted` → убедиться, что подписка есть и под
 * текущим ключом (`ensureBrowserPushSubscription`). Один раз за сессию вкладки.
 *
 * Первая попытка ЖДЁТ готовности service worker'а (`waitForServiceWorkerReady`,
 * таймаут внутри). До 10.09 она стартовала сразу после маунта, а SW в этот
 * момент ещё `installing`: подписки у него нет, `subscribe` падает. Человек
 * видел «уведомления включены» и не получал ничего, пока не выходил из аккаунта
 * и не входил заново — владелец: «поменяла браузер на хром, тоже сразу не
 * работало, потом вышла из сессии в браузере, и потом заработали». Перелогин
 * просто давал SW время активироваться. Повторы с паузой остались: готовность
 * SW не обещает, что бэк ответит с первого раза.
 *
 * Флаг «сверено» ставится ТОЛЬКО при `ok === true`. Иначе одна неудача запирала
 * сверку на всю сессию вкладки: перезагрузка страницы её не повторяла, и
 * починить состояние можно было лишь новым входом — тем самым перелогином.
 *
 * Исход КАЖДОЙ попытки кладётся в `pushDeviceStore` (ADR-175): раньше сверка
 * молчала при любом отказе, и «разрешение granted, подписок ноль» (прод 10.09)
 * нельзя было объяснить ни человеку в настройках, ни себе при разборе.
 */
const SESSION_FLAG = 'porukam.push.ensured';
const RETRY_DELAYS_MS = [0, 3000, 10000];

export function usePushResubscribe(): void {
  const { data: settings } = useNotificationSettings();
  const wanted = settings?.push === true;

  useEffect(() => {
    if (!wanted || typeof window === 'undefined') return;
    // Обёртка с нативным токеном (ADR-176): уведомления показывает приложение,
    // и вторая, браузерная подписка на том же телефоне дала бы два уведомления
    // на одно событие. Web Push здесь не создаётся вовсе.
    if (getNativePushState().active) return;
    if (getBrowserPushPermission() !== 'granted') return;
    try {
      if (window.sessionStorage.getItem(SESSION_FLAG) === '1') return;
    } catch {
      // sessionStorage недоступен (приватный режим) — просто попробуем ещё раз при следующем маунте.
    }
    let cancelled = false;
    const timers: number[] = [];
    const attempt = (index: number): void => {
      timers.push(
        window.setTimeout(() => {
          if (cancelled) return;
          void ensureBrowserPushSubscription().then((result) => {
            if (cancelled) return;
            // Последняя попытка — та, о которой рассказывает подсказка под тумблером;
            // промежуточные неудачи перезаписываются следующей попыткой.
            recordPushSubscribeResult(result);
            // Только настоящий успех: неудача, помеченная как «сделано», молчит
            // до конца сессии вкладки и лечится лишь новым входом.
            if (result.ok === true) {
              try {
                window.sessionStorage.setItem(SESSION_FLAG, '1');
              } catch {
                // best effort
              }
              return;
            }
            if (index + 1 < RETRY_DELAYS_MS.length) attempt(index + 1);
          });
        }, RETRY_DELAYS_MS[index]),
      );
    };
    // Ответ ожидания не проверяем: SW нет или он не успел — попытка всё равно
    // нужна, она вернёт причину (`no_sw`), а без неё под тумблером было бы пусто.
    void waitForServiceWorkerReady().then(() => {
      if (!cancelled) attempt(0);
    });
    return () => {
      cancelled = true;
      timers.forEach((id) => window.clearTimeout(id));
    };
  }, [wanted]);
}
