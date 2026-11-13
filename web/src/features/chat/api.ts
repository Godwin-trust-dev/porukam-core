import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ChatMessagesResponse, ChatMessage, ChatThread } from '@porukam/core';
import { api } from '../../shared/api';
import { isFeatureEnabled } from '../../shared/features';
import { useAuthStore } from '../auth/authStore';
import { useActorKey } from '../actor/actorStore';

/**
 * Переписка по договору (ADR-112). Realtime — поллинг TanStack Query
 * (ADR-112 §6): тред — каждые 5 с, список диалогов — каждые 10 с; WebSocket
 * осознанно не подключаем, пока нет метрики, что поллинга мало.
 */

export function useChatThreads(enabled = true) {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  // См. `useNotificationsFeed`: актёр в ключе, чтобы бейдж и список диалогов не
  // «протекали» между контекстами (ADR-129).
  const actorKey = useActorKey();
  return useQuery({
    queryKey: ['chat', 'threads', actorKey],
    queryFn: () => api.request<ChatThread[]>('/messages/threads'),
    enabled: isAuthenticated && enabled,
    refetchInterval: 10_000,
  });
}

/**
 * Число диалогов с непрочитанным — для бейджа в навигации оболочки. Делит
 * кэш useChatThreads (тот же поллинг 10 с), собственного запроса не
 * порождает — та же схема, что useNotificationsUnreadCount у уведомлений.
 * За выключенным фич-флагом chat запрос не выполняется вовсе (счётчик 0).
 */
export function useChatUnreadCount(): number {
  const { data } = useChatThreads(isFeatureEnabled('chat'));
  return data?.filter((thread) => thread.unread_count > 0).length ?? 0;
}

export function useChatMessages(contractId: string | undefined) {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  return useQuery({
    queryKey: ['chat', 'messages', contractId],
    queryFn: () => api.request<ChatMessagesResponse>(`/contracts/${contractId}/messages`),
    enabled: isAuthenticated && !!contractId,
    refetchInterval: 5_000,
  });
}

export function useSendChatMessage(contractId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: string) =>
      api.request<ChatMessage>(`/contracts/${contractId}/messages`, {
        method: 'POST',
        body: { body },
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['chat', 'messages', contractId] });
      void qc.invalidateQueries({ queryKey: ['chat', 'threads'] });
    },
  });
}

export function useMarkChatRead(contractId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      api.request<ChatMessagesResponse>(`/contracts/${contractId}/messages/read`, {
        method: 'POST',
      }),
    onSuccess: (data) => {
      qc.setQueryData(['chat', 'messages', contractId], data);
      void qc.invalidateQueries({ queryKey: ['chat', 'threads'] });
    },
  });
}
