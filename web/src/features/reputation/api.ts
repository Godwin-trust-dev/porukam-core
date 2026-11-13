import { useQuery } from '@tanstack/react-query';
import type { HandlePublic, ReputationCard, ReputationInsights } from '@porukam/core';
import { api } from '../../shared/api';

/**
 * Репутационная карточка на РЕАЛЬНЫХ путях (ADR-076/093). Оба запроса —
 * `AllowAny` на бэке: гость видит публичную карточку без токена.
 *
 * Идентификаторы разведены намеренно: карточка ключуется `profile_id`
 * (`GET /v1/reputation/profiles/{id}/card`), а публичная ссылка — хендлом
 * (`/@handle`), поэтому маршрут по хендлу сначала разрешает его в профиль
 * через `GET /v1/handles/{handle}`. Обратная сторона — карточка сама несёт
 * `handle`, и маршрут по `profile_id` (ссылка со стороны договора) может
 * показать тот же публичный идентификатор и статус верификации.
 *
 * Никакого агрегирования на фронте: доли, оси по ролям и строки сфер
 * приходят готовыми парами «сделано / всего» (ADR-163 §2) — фронт считает
 * из них ровно процент и цветовую зону, ничего не складывая. Объёма по
 * валютам и доли защищённых платежей в карточке нет вовсе; они живут в
 * приватном `useReputationInsights` ниже.
 */
export function useHandlePublic(handle: string | null | undefined) {
  const value = (handle ?? '').replace(/^@/, '');
  return useQuery({
    queryKey: ['handle-public', value],
    queryFn: () => api.request<HandlePublic>(`/handles/${encodeURIComponent(value)}`),
    retry: false,
    enabled: value.length > 0,
  });
}

export function useReputationCard(profileId: string | null | undefined) {
  return useQuery({
    queryKey: ['reputation-card', profileId],
    queryFn: () => api.request<ReputationCard>(`/reputation/profiles/${profileId}/card`),
    retry: false,
    enabled: Boolean(profileId),
  });
}

/**
 * `GET /v1/reputation/profiles/{id}/insights` — приватный разбор СВОЕЙ
 * карточки (ADR-163 §8). Отдельный запрос, а не поле карточки: у этого
 * документа нет ни одной аудитории, кроме владельца, и бэк отвечает на
 * него 403 всем остальным. `retry: false` — 403 повторять нечем.
 */
export function useReputationInsights(profileId: string | null | undefined) {
  return useQuery({
    queryKey: ['reputation-insights', profileId],
    queryFn: () => api.request<ReputationInsights>(`/reputation/profiles/${profileId}/insights`),
    retry: false,
    enabled: Boolean(profileId),
  });
}
