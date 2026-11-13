import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { SavedContact } from '@porukam/core';
import { api } from '../../shared/api';

/** Справочник контактов владельца — `GET /v1/users/me/contacts` (apps.social,
 * граф доверия приватен: только собственные рёбра). Заполняется автоматически
 * с черновика договора (ADR-106) и вручную с карточки репутации. */
export function useSavedContacts(enabled = true) {
  return useQuery({
    queryKey: ['saved-contacts'],
    queryFn: () => api.request<SavedContact[]>('/users/me/contacts'),
    enabled,
  });
}

export function useSaveContact() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { target_handle: string } | { target_user_id: string }) =>
      api.request<SavedContact>('/users/me/contacts', { method: 'POST', body: input }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['saved-contacts'] }),
  });
}

export function useRemoveContact() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (contactId: string) => api.request<void>(`/users/me/contacts/${contactId}`, { method: 'DELETE' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['saved-contacts'] }),
  });
}
