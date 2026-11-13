import { useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '../../shared/api';
import { useAuthStore } from './authStore';
import { useActorStore } from '../actor/actorStore';
import { unregisterNativePushToken } from '../notifications/nativePushToken';

/**
 * Выход из аккаунта (замечание владельца 07.09: «У нас нигде нет кнопки
 * "Выйти", чтобы сменить аккаунт»).
 *
 * До этой ветки выход жил ТОЛЬКО в разделе «Безопасность» настроек, а сам
 * раздел с 2026-08-21 скрыт из списка (`settings/sections.ts`) — то есть был
 * недостижим. Здесь — общий обработчик для шапки (`ActorSwitcher`) и хаба
 * настроек.
 *
 * Порядок намеренный:
 *
 * 1. `POST /auth/logout` с текущим refresh — бэк кладёт его в блэклист
 *    (`ROTATE_REFRESH_TOKENS` + `BLACKLIST_AFTER_ROTATION`, ADR-107), иначе
 *    украденная пара продолжала бы работать до истечения срока. Ответ НЕ
 *    ждём и ошибку глотаем: выход на устройстве не должен зависеть от сети —
 *    иначе в офлайне человек остаётся заперт в чужом аккаунте.
 * 2. Локальная сессия и кэш чистятся ВСЕГДА: токены (`authStore`, вместе с
 *    `localStorage`), актёр (`actorStore`) и react-query целиком — в нём
 *    лежат данные ушедшего пользователя, и следующий вход не должен увидеть
 *    их ни на кадр.
 * 3. Нативный токен устройства снимается с аккаунта (ADR-176): иначе следующий
 *    человек, вошедший на этом телефоне, получал бы уведомления предыдущего.
 *    Запрос уходит ДО очистки токенов (ему нужен `Authorization`) и, как и
 *    отзыв refresh, не ожидается. Локальная запись НЕ удаляется: токен
 *    принадлежит устройству, следующий вход зарегистрирует его заново.
 * 4. `/welcome` — тот же экран, куда уводит `RequireAuth`.
 *
 * Новой бизнес-логики на бэке не появляется: эндпоинт `auth/logout`
 * существует с самого начала (`apps.accounts.api.urls`).
 */
export function useLogout(): () => void {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const logout = useAuthStore((s) => s.logout);
  const resetActor = useActorStore((s) => s.reset);

  return useCallback(() => {
    // Читаем токен из стора В МОМЕНТ клика: подписка на поле пересоздавала бы
    // обработчик на каждой ротации пары.
    const refresh = useAuthStore.getState().refresh;
    if (refresh) {
      void api.request<void>('/auth/logout', { method: 'POST', body: { refresh } }).catch(() => {
        // Отзыв не удался (сеть/мок без эндпоинта) — локальный выход всё равно
        // состоится; refresh протухнет сам.
      });
    }
    // Пока `Authorization` ещё жив: снять токен устройства с уходящего аккаунта.
    void unregisterNativePushToken();
    logout();
    resetActor();
    qc.clear();
    navigate('/welcome', { replace: true });
  }, [qc, navigate, logout, resetActor]);
}
