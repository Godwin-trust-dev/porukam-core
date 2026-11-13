import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Group, GroupGeoScope, GroupKind, GroupLink, GroupMemberRow } from '@porukam/core';
import { api } from '../../shared/api';

/**
 * Объединения (apps.social, отсмотр 2026-08-23; v2 — ADR-117/118).
 *
 * Чтение (`GET /groups`, `/groups/{id}`, `/groups/{id}/members`) — `AllowAny`
 * на бэке (ADR-117 §6): гость видит публичные объединения без токена, поэтому
 * запросы НЕ гейтятся `isAuthenticated`. `actor: true` — X-Acting-Profile
 * уходит только когда актёр есть; без него `my_membership` приходит `null`.
 */

export function useGroups() {
  return useQuery({
    queryKey: ['groups'],
    queryFn: () => api.request<Group[]>('/groups', { actor: true }),
  });
}

export function useGroup(groupId: string | undefined) {
  return useQuery({
    queryKey: ['groups', groupId],
    queryFn: () => api.request<Group>(`/groups/${groupId}`, { actor: true }),
    retry: false,
    enabled: !!groupId,
  });
}

export function useGroupMembers(groupId: string | undefined) {
  return useQuery({
    queryKey: ['groups', groupId, 'members'],
    queryFn: () => api.request<GroupMemberRow[]>(`/groups/${groupId}/members`, { actor: true }),
    enabled: !!groupId,
  });
}

function useInvalidateGroup(groupId: string | undefined) {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: ['groups'] });
    if (groupId) void qc.invalidateQueries({ queryKey: ['groups', groupId] });
  };
}

/** Поля витрины, общие для создания и настроек (ADR-117 §§1–4). */
export interface GroupFormInput {
  kind: GroupKind;
  name: string;
  description: string;
  sphere_code: string;
  geo_scope: GroupGeoScope;
  country_code: string;
  city_name: string;
  links: GroupLink[];
  is_public: boolean;
  join_policy: Group['join_policy'];
}

/** `POST /groups` — хендл ОБЯЗАТЕЛЕН при создании (ADR-117 §5), без «@».
 * Ошибки: 409 `handle_taken`, 422 `invalid_handle` / `invalid_sphere` / `invalid_geo`. */
export function useCreateGroup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: GroupFormInput & { handle: string }) =>
      api.request<Group>('/groups', { actor: true, method: 'POST', body: input }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['groups'] }),
  });
}

/** `PATCH /groups/{id}` — лидер/админ; частичное обновление (`GroupUpdateSerializer`). */
export function useUpdateGroup(groupId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: Partial<GroupFormInput>) =>
      api.request<Group>(`/groups/${groupId}`, { actor: true, method: 'PATCH', body: patch }),
    onSuccess: (group) => {
      qc.setQueryData(['groups', groupId], group);
      void qc.invalidateQueries({ queryKey: ['groups'] });
    },
  });
}

/** `POST /groups/{id}/logo` — multipart, поле `file` (ADR-117 §8, тот же
 * пайплайн, что аватар ADR-103). Ошибки: 413 `logo_too_large`, 422
 * `invalid_logo_image`. Ответ — `GroupSerializer` с новым `logo_url` (`v=`
 * версионирован — кэш `<img>` сбрасывается сам). */
export function useUploadGroupLogo(groupId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (file: File) => {
      const body = new FormData();
      body.append('file', file);
      return api.request<Group>(`/groups/${groupId}/logo`, { actor: true, method: 'POST', body });
    },
    onSuccess: (group) => {
      qc.setQueryData(['groups', groupId], group);
      void qc.invalidateQueries({ queryKey: ['groups'] });
    },
  });
}

/** `DELETE /groups/{id}/logo` — идемпотентно, ответ — `GroupSerializer`. */
export function useRemoveGroupLogo(groupId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.request<Group>(`/groups/${groupId}/logo`, { actor: true, method: 'DELETE' }),
    onSuccess: (group) => {
      qc.setQueryData(['groups', groupId], group);
      void qc.invalidateQueries({ queryKey: ['groups'] });
    },
  });
}

export function useJoinGroup(groupId: string | undefined) {
  const invalidate = useInvalidateGroup(groupId);
  return useMutation({
    mutationFn: () => api.request<GroupMemberRow>(`/groups/${groupId}/join`, { actor: true, method: 'POST', body: {} }),
    onSuccess: invalidate,
  });
}

export function useLeaveGroup(groupId: string | undefined) {
  const invalidate = useInvalidateGroup(groupId);
  return useMutation({
    mutationFn: () => api.request<void>(`/groups/${groupId}/leave`, { actor: true, method: 'POST', body: {} }),
    onSuccess: invalidate,
  });
}

export function useDecideRequest(groupId: string | undefined) {
  const invalidate = useInvalidateGroup(groupId);
  return useMutation({
    mutationFn: ({ membershipId, approve }: { membershipId: number; approve: boolean }) =>
      api.request<GroupMemberRow>(
        `/groups/${groupId}/requests/${membershipId}/${approve ? 'approve' : 'reject'}`,
        { method: 'POST', body: {} },
      ),
    onSuccess: invalidate,
  });
}

export function useInviteMember(groupId: string | undefined) {
  const invalidate = useInvalidateGroup(groupId);
  return useMutation({
    mutationFn: (handle: string) =>
      api.request<GroupMemberRow>(`/groups/${groupId}/members`, { actor: true, method: 'POST', body: { handle } }),
    onSuccess: invalidate,
  });
}

/** `POST /groups/{id}/handle` — СМЕНА хендла в настройках (ADR-117 §5);
 * при создании хендл уходит в `useCreateGroup`. Ошибки: 409 `handle_taken`,
 * 422 `invalid_handle`. */
export function useSetGroupHandle(groupId: string | undefined) {
  const invalidate = useInvalidateGroup(groupId);
  return useMutation({
    mutationFn: (value: string) =>
      api.request<Group>(`/groups/${groupId}/handle`, { actor: true, method: 'POST', body: { value } }),
    onSuccess: invalidate,
  });
}
