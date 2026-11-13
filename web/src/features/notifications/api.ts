import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type InfiniteData,
  type QueryClient,
} from '@tanstack/react-query';
import type { NotificationFilter, NotificationsFeedResponse, NotificationSettings } from '@porukam/core';
import { api } from '../../shared/api';
import { useAuthStore } from '../auth/authStore';
import { useActorKey } from '../actor/actorStore';

/** Страница ленты (решение владельца 05.09: «пусть штук 15 висят, далее кнопка "показать ещё"»). */
export const NOTIFICATIONS_PAGE_SIZE = 15;

type NotificationsFeedPages = InfiniteData<NotificationsFeedResponse, string | null>;

/**
 * Лента уведомлений (DEV-14 §7): личный эндпоинт, без X-Acting-Profile.
 * Пагинация курсорная — бэк отдаёт `next_cursor` по паре `(created_at, id)`;
 * offset тут не годится, лента растёт сверху и страницы бы съезжали.
 */
export function useNotificationsFeed(filter: NotificationFilter = 'all') {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  // Актёр в ключе (ADR-129): лента личная, но при смене контекста экран не
  // должен секунду показывать счётчики и строки прежнего актёра.
  const actorKey = useActorKey();
  return useInfiniteQuery({
    queryKey: ['notifications', actorKey, filter],
    queryFn: ({ pageParam }) =>
      api.request<NotificationsFeedResponse>('/notifications', {
        query: { filter, limit: NOTIFICATIONS_PAGE_SIZE, cursor: pageParam },
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.next_cursor,
    enabled: isAuthenticated,
  });
}

/**
 * Счётчики ленты (бейдж в оболочке, плитка в `/me`) — первая страница того же
 * кэша, что и экран уведомлений: `unread_count`/`groups` бэк считает по ВСЕЙ
 * ленте, а не по странице, поэтому первой страницы довольно и второй запрос
 * не нужен.
 */
export function useNotificationsSummary(): NotificationsFeedResponse | undefined {
  const { data } = useNotificationsFeed('all');
  return data?.pages[0];
}

/** Только счётчик непрочитанных — для бейджа в оболочке (сайдбар/bottom-nav). Общий кэш с лентой. */
export function useNotificationsUnreadCount(): number {
  return useNotificationsSummary()?.unread_count ?? 0;
}

/**
 * «Прочитано» правит уже загруженные страницы НА МЕСТЕ, без invalidate:
 * инвалидация infinite-запроса перезапрашивает ВСЕ догруженные страницы, и
 * человек, дочитавший до пятой, платил бы за каждый тап по пункту пятью
 * запросами и прыжком списка. Счётчики берём из ответа — бэк считает их по
 * всей ленте, поэтому первой страницы хватает и на вкладки.
 */
function applyRead(qc: QueryClient, fresh: NotificationsFeedResponse, id?: string): void {
  qc.setQueriesData<NotificationsFeedPages>({ queryKey: ['notifications'] }, (old) =>
    old == null
      ? old
      : {
          ...old,
          pages: old.pages.map((page) => ({
            ...page,
            unread_count: fresh.unread_count,
            groups: fresh.groups,
            items: page.items.map((n) => (id === undefined || n.id === id ? { ...n, read: true } : n)),
          })),
        },
  );
}

export function useMarkNotificationRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.request<NotificationsFeedResponse>(`/notifications/${id}/read`, { method: 'POST' }),
    onSuccess: (fresh, id) => applyRead(qc, fresh, id),
  });
}

export function useMarkAllNotificationsRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.request<NotificationsFeedResponse>('/notifications/read-all', { method: 'POST' }),
    onSuccess: (fresh) => applyRead(qc, fresh),
  });
}

export function useNotificationSettings() {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  return useQuery({
    queryKey: ['notification-settings'],
    queryFn: () => api.request<NotificationSettings>('/notification-settings'),
    enabled: isAuthenticated,
  });
}

export function useUpdateNotificationSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: Partial<Omit<NotificationSettings, 'in_app'>>) =>
      api.request<NotificationSettings>('/notification-settings', { method: 'PUT', body: patch }),
    onSuccess: (settings) => qc.setQueryData(['notification-settings'], settings),
  });
}
