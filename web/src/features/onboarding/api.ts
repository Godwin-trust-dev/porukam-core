import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { DriveBackupState, GlobalConsentState, GlobalPrivacyConsentsInput, InviteInfo } from '@porukam/core';
import { api } from '../../shared/api';
import { useAuthStore } from '../auth/authStore';

/**
 * GET/POST /users/me/privacy-consents-global — шаг «Данные и приватность»
 * (ConsentsStep, DEV-auth-onboarding §5, ADR-071). `enabled` — доп. гейт
 * (гард `RequireGlobalOnboarding` включает запрос только для Google-сессий:
 * у OTP-пользователей нет активного GLOBAL-аккаунта в моке, 401 не к месту).
 */
export function useGlobalConsents(enabled = true) {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  return useQuery({
    queryKey: ['onboarding', 'consents-global'],
    queryFn: () => api.request<GlobalConsentState>('/users/me/privacy-consents-global'),
    enabled: isAuthenticated && enabled,
  });
}

export function useSubmitGlobalConsents() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: GlobalPrivacyConsentsInput) =>
      api.request<GlobalConsentState>('/users/me/privacy-consents-global', {
        method: 'POST',
        body: input,
        idempotent: true,
      }),
    onSuccess: (state) => qc.setQueryData(['onboarding', 'consents-global'], state),
  });
}

/** GET/POST /users/me/drive-backup — шаг «Бэкап» (§6), опционален, МОК-ТОЛЬКО
 * (реальный Drive-контур — ГВ.3, вне скоупа DEV-auth-onboarding). */
export function useDriveBackup() {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  return useQuery({
    queryKey: ['onboarding', 'drive-backup'],
    queryFn: () => api.request<DriveBackupState>('/users/me/drive-backup'),
    enabled: isAuthenticated,
  });
}

export function useConnectDriveBackup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.request<DriveBackupState>('/users/me/drive-backup', { method: 'POST', idempotent: true }),
    onSuccess: (state) => qc.setQueryData(['onboarding', 'drive-backup'], state),
  });
}

/** GET /invites/:token — приглашение по ссылке (Welcome `?invite=`, §3).
 * МОК-ТОЛЬКО: у бэка сейчас нет контура приглашений (см. authGlobalHandlers.ts). */
export function useInvite(token: string | null) {
  return useQuery({
    queryKey: ['invite', token],
    queryFn: () => api.request<InviteInfo>(`/invites/${encodeURIComponent(token ?? '')}`),
    enabled: Boolean(token),
    retry: false,
  });
}
