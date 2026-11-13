import { ApiClient } from '@porukam/core';
import { useAuthStore } from '../features/auth/authStore';
import { useActorStore } from '../features/actor/actorStore';
import { getActiveLocale } from './activeLocale';

/**
 * Единый экземпляр API-клиента. baseUrl = /v1 (техспецификация §7).
 * В mock-режиме запросы перехватывает MSW; переключение на реальный API (Ф6)
 * не требует переписывания клиента — меняется только baseUrl/окружение.
 */
export const api = new ApiClient({
  baseUrl: '/v1',
  getLocale: getActiveLocale,
  getAccessToken: () => useAuthStore.getState().access,
  getActingProfileId: () => useActorStore.getState().activeProfileId,
  // Тихое продление сессии (отсмотр прода 2026-08-18 №9): access живёт 15
  // минут — по 401 клиент сам обновляет пару и повторяет запрос; если refresh
  // отклонён — logout, и реактивный RequireAuth уводит на экран входа
  // (вместо тупикового ErrorState с authentication_required).
  getRefreshToken: () => useAuthStore.getState().refresh,
  onTokensRefreshed: (tokens) => {
    const store = useAuthStore.getState();
    store.setTokens(tokens, store.loginMethod ?? undefined);
  },
  onAuthExpired: () => useAuthStore.getState().logout(),
});
