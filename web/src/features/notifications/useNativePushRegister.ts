import { useEffect } from 'react';
import { useAuthStore } from '../auth/authStore';
import { useCurrentUserId } from '../auth/useAuth';
import {
  getNativePushState,
  getNativePushToken,
  needsNativePushRegister,
  registerNativePushToken,
  updateNativePushRecord,
} from './nativePushToken';
import { unsubscribeBrowserPush } from './push';

/**
 * Регистрация нативного токена устройства на бэке после входа (ADR-176).
 *
 * Токен приезжает от обёртки в стартовом URL и оседает в `localStorage`
 * (`nativePushToken.ts`) ДО того, как человек вошёл: обёртка открывает
 * приложение на экране входа так же, как и на ленте. Значит момент регистрации —
 * не приём токена, а появление сессии, и живёт эта проверка в оболочке, рядом со
 * сверкой Web Push-подписки (`usePushResubscribe`).
 *
 * Регистрация повторяется:
 *  - при смене пользователя — в одно приложение можно войти другим аккаунтом, и
 *    токен обязан переехать к новому владельцу (он принадлежит устройству, как
 *    endpoint у Web Push);
 *  - раз в сутки — это отметка `last_seen`, по которой бэк отличает живое
 *    устройство от давно удалённого.
 *
 * Ретраи те же, что у сверки Web Push (0/3/10 с): первый заход может прийтись на
 * момент, когда сеть ещё не поднялась после запуска приложения. `401` из ретраев
 * исключён намеренно — это не сбой канала, а «ещё не вошли»; повтор придёт со
 * входом, а не через три секунды.
 *
 * ПЕРВАЯ успешная регистрация снимает Web Push-подписку этого браузера: иначе
 * один телефон получит на одно событие два уведомления — от приложения Porukam и
 * от браузера. Делается ровно один раз (`webPushCleared`), дальше в этом режиме
 * подписка не создаётся вовсе.
 */
const RETRY_DELAYS_MS = [0, 3000, 10000];

export function useNativePushRegister(): void {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  // id из кэша `['me']`, без собственного запроса: он нужен только чтобы поймать
  // смену владельца. Пока кэш пуст — регистрируем «без владельца», а появившийся
  // id сам вызовет перерегистрацию (на бэке она идемпотентна по токену).
  const userId = useCurrentUserId();

  useEffect(() => {
    if (!isAuthenticated || typeof window === 'undefined') return;
    const { active, record } = getNativePushState();
    if (!active || !record) return;
    if (!needsNativePushRegister(record, userId)) return;

    let cancelled = false;
    const timers: number[] = [];
    const attempt = (index: number): void => {
      timers.push(
        window.setTimeout(() => {
          if (cancelled) return;
          const current = getNativePushToken();
          if (!current) return;
          void registerNativePushToken(current).then(async (result) => {
            if (cancelled) return;
            updateNativePushRecord(
              result.ok
                ? { registeredAt: new Date().toISOString(), registeredFor: userId ?? undefined, lastResult: result }
                : { lastResult: result },
            );
            if (result.ok) {
              const saved = getNativePushToken();
              if (saved && !saved.webPushCleared) {
                await unsubscribeBrowserPush();
                updateNativePushRecord({ webPushCleared: true });
              }
              return;
            }
            if (result.reason === 'unauthorized') return;
            if (index + 1 < RETRY_DELAYS_MS.length) attempt(index + 1);
          });
        }, RETRY_DELAYS_MS[index]),
      );
    };
    attempt(0);

    return () => {
      cancelled = true;
      timers.forEach((id) => window.clearTimeout(id));
    };
  }, [isAuthenticated, userId]);
}
