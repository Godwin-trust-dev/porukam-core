import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AccountDeletionBlockedContext,
  AccountDeletionResult,
  ActorProfile,
  CurrentUser,
  DeviceSession,
  DriveConnectCallbackInput,
  OwnerProfileSettings,
} from '@porukam/core';
import { ApiError } from '@porukam/core';
import { api } from '../../shared/api';
import { useActorStore } from '../actor/actorStore';
import { useAuthStore } from '../auth/authStore';

/** `/v1/users/me` (apps.accounts) PATCH-принимает буквально это — не
 * `handle`/`about`/`city`/`remote`/`spheres`/`avatarUrl` (ADR-086/087, docs/tasks/
 * Задача_fix_web-profile-settings-real-api.md): те либо в apps.profiles/
 * apps.social (свои эндпоинты ниже), либо на бэке не существуют вовсе (Tier B). */
export type ProfilePatch = Partial<Pick<CurrentUser, 'display_name' | 'locale' | 'phone' | 'country_code'>>;

/** Собственный person-профиль владельца (не бизнес/юрлицо) — id для
 * `useOwnProfileSettings`/`useUpdateOwnProfileSettings` ниже. `CurrentUser.
 * profiles` уже приходит с `GET /v1/users/me` (apps.accounts, import_string
 * из apps.profiles, ADR-086) — отдельного запроса не нужно. */
export function findOwnPersonProfileId(profiles: ActorProfile[] | undefined): string | undefined {
  return profiles?.find((p) => p.kind === 'person')?.id;
}

/** PATCH языка интерфейса для залогиненного пользователя (DEV-16a §3) — та же мутация,
 * что и остальной профиль (`/users/me`), едет на все устройства. */
export function useUpdateLocale() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (locale: string) => api.request<CurrentUser>('/users/me', { method: 'PATCH', body: { locale } }),
    onSuccess: (me) => qc.setQueryData(['me'], me),
  });
}

/** PATCH профиля (§5): оптимистично обновляет кэш `['me']`. */
export function useUpdateProfile() {
  const qc = useQueryClient();
  const setProfiles = useActorStore((s) => s.setProfiles);
  return useMutation({
    mutationFn: (patch: ProfilePatch) => api.request<CurrentUser>('/users/me', { method: 'PATCH', body: patch }),
    onSuccess: (me) => {
      qc.setQueryData(['me'], me);
      // Первый @handle свежего GLOBAL-аккаунта заводит person-профиль на
      // моке (DEV-auth-onboarding §6) — актёр-контекст должен узнать о нём,
      // иначе X-Acting-Profile не появится нигде после онбординга. Для RU,
      // где профили уже заполнены при входе, это обычная ресинхронизация.
      setProfiles(me.profiles);
    },
  });
}

/** GET /profiles/{id} (apps.profiles, ПУБЛИЧНЫЙ — тот же эндпоинт видит гость по
 * ссылке; здесь читаем СВОЙ профиль) — city/remote/видимость/показ имени/аватара:
 * реальный дом этих полей (docs/tasks/Задача_fix_web-profile-settings-real-api.md,
 * ADR-087), НЕ `/v1/users/me` (apps.accounts). */
export function useOwnProfileSettings(profileId: string | undefined) {
  return useQuery({
    queryKey: ['profile-settings', profileId],
    queryFn: () => api.request<OwnerProfileSettings>(`/profiles/${profileId}`),
    enabled: Boolean(profileId),
  });
}

export type OwnerProfileSettingsPatch = Partial<
  Pick<
    OwnerProfileSettings,
    'city_name' | 'works_remotely' | 'sphere_codes' | 'work_type_codes' | 'profile_visibility' | 'hide_from_catalog' | 'show_name' | 'avatar_visibility'
  >
>;

/** PATCH /profiles/{id} (apps.profiles) — реальный контракт `ProfileUpdateSerializer`,
 * права проверяет `services.update_profile` (владелец либо представитель с
 * manage_profile; бизнес-профиль → 409 profile_visibility_locked на попытку
 * сменить видимость, Р5 ADR-059 — бизнес всегда публичен). */
export function useUpdateOwnProfileSettings(profileId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: OwnerProfileSettingsPatch) => {
      if (!profileId) throw new Error('useUpdateOwnProfileSettings: profileId ещё не известен');
      return api.request<OwnerProfileSettings>(`/profiles/${profileId}`, { method: 'PATCH', body: patch });
    },
    onSuccess: (data) => qc.setQueryData(['profile-settings', profileId], data),
  });
}

/** POST /profiles/{id}/avatar (apps.profiles, ADR-103) — multipart, поле `file`.
 * Ответ — тот же `ProfileSerializer`, что и `GET /profiles/{id}`, с новым
 * `avatar_url` (версионирован `v=`, кэш `<img>` сбрасывается сам). Ошибки —
 * 413 `avatar_too_large` / 422 `invalid_avatar_image` (`ApiError.code`).
 * Обновляем и `['me']` — `CurrentUser.profiles[].avatar_url` (хаб `/me`). */
export function useUploadAvatar(profileId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (file: File) => {
      if (!profileId) throw new Error('useUploadAvatar: profileId ещё не известен');
      const body = new FormData();
      body.append('file', file);
      return api.request<OwnerProfileSettings>(`/profiles/${profileId}/avatar`, { method: 'POST', body });
    },
    onSuccess: (data) => {
      qc.setQueryData(['profile-settings', profileId], data);
      void qc.invalidateQueries({ queryKey: ['me'] });
    },
  });
}

/** DELETE /profiles/{id}/avatar (ADR-103) — идемпотентно; объекты удаляются
 * физически, фото из Google после этого само не возвращается. */
export function useRemoveAvatar(profileId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => {
      if (!profileId) throw new Error('useRemoveAvatar: profileId ещё не известен');
      return api.request<OwnerProfileSettings>(`/profiles/${profileId}/avatar`, { method: 'DELETE' });
    },
    onSuccess: (data) => {
      qc.setQueryData(['profile-settings', profileId], data);
      void qc.invalidateQueries({ queryKey: ['me'] });
    },
  });
}

/** Согласия ПОСЛЕ регистрации (apps.social, docs/tasks/
 * Задача_fix_web-profile-settings-real-api.md) — НЕ путать с `useGlobalConsents`/
 * `useSubmitGlobalConsents` (features/onboarding/api.ts, `/users/me/
 * privacy-consents-global`, стартовый пакет при регистрации, все 4 сразу,
 * без null). Здесь — смена ОДНОГО согласия (сейчас нужно только
 * `phone_discoverability` — «находимость по телефону», PrivacySettingsPage). */
export function useMyConsents() {
  return useQuery({
    queryKey: ['my-consents'],
    queryFn: () =>
      api.request<{ pd_processing: boolean | null; profile_public: boolean | null; phone_discoverability: boolean | null; completed: boolean }>(
        '/users/me/consents',
      ),
  });
}

export function useRecordConsent() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { consent_type: 'phone_discoverability'; value: boolean }) =>
      api.request('/users/me/consents', { method: 'POST', body: input }),
    onSuccess: (data) => qc.setQueryData(['my-consents'], data),
  });
}

/** Проверка занятости хендла при смене (§5) — «свободно/занят».
 * ⚠ `/users/handle-available` — МОК-ТОЛЬКО, на боевом бэке эндпоинта нет
 * (docs/tasks/Задача_fix_web-profile-handle-real-api.md §5) — запрос молча
 * ошибётся (404 через `location /v1/` → Django), `status` в потребителях
 * остаётся `'idle'` (не блокирует «Продолжить»); окончательная проверка —
 * `useClaimHandle` при сабмите (409 `handle_taken` уже обрабатывается). */
export function useHandleAvailability(handle: string) {
  // Реальный контур: эндпоинта НЕТ (мок-only, см. докстринг) — запрос был бы
  // гарантированным 404 на каждый 3-й символ ввода хендла. На проде это
  // совпало с «выбрасывает после 3-й буквы» у тестировщика (2026-08-24):
  // лишний сетевой вызов через Cloudflare на самом чувствительном шаге
  // онбординга убран совсем; статус остаётся 'idle', занятость проверяет
  // сабмит (POST /users/me/handle → 409 handle_taken, как и раньше).
  const isMock = (import.meta.env.VITE_API_MODE ?? 'mock') === 'mock';
  return useQuery({
    queryKey: ['handle-available', handle],
    queryFn: () => api.request<{ available: boolean }>('/users/handle-available', { query: { handle } }),
    enabled: isMock && handle.length > 1 && handle.startsWith('@'),
    retry: false,
  });
}

/** POST /users/me/handle (apps.social, реальный контракт) — назначение/смена
 * хендла ОТДЕЛЬНО от `PATCH /users/me` (docs/tasks/
 * Задача_fix_web-profile-handle-real-api.md): реальный `UserMeUpdateSerializer`
 * `handle` не принимает вообще (DRF молча игнорирует поле) — хендл живёт в
 * apps.social, свой эндпоинт. `value` — БЕЗ "@" (бэк сам нормализует,
 * `_normalize_handle` лишний ведущий "@" тоже стерпит). Ошибки — 409
 * `handle_taken` / 422 `invalid_handle_format` (`ApiError.code`).
 * БЕЗ `idempotent: true` — `MyHandleView` (apps.social) не подключён к
 * `common/api/idempotency.py` (тот — для денежных/подписных POST, CLAUDE.md;
 * повтор с тем же значением и так не ломает состояние, `claim_handle`
 * возвращает существующий активный хендл, не создаёт дубликат). */
export function useClaimHandle() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (value: string) =>
      api.request<{ handle: string; kind: string; verified: boolean }>('/users/me/handle', {
        method: 'POST',
        body: { value },
      }),
    onSuccess: () => {
      // Сам ответ (`HandlePublicSerializer`) не несёт полной формы `CurrentUser` —
      // проще инвалидировать кэш `['me']`, чем собирать его вручную из кусков.
      void qc.invalidateQueries({ queryKey: ['me'] });
    },
  });
}

export function useSessions() {
  return useQuery({
    queryKey: ['sessions'],
    queryFn: () => api.request<{ results: DeviceSession[] }>('/sessions'),
    // Эндпоинта на бэке пока нет — не долбить 404 ретраями.
    retry: false,
  });
}

export function useLogoutSession() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.request<{ results: DeviceSession[] }>(`/sessions/${id}`, { method: 'DELETE' }),
    onSuccess: (data) => qc.setQueryData(['sessions'], data),
  });
}

export function useLogoutAllSessions() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.request<{ results: DeviceSession[] }>('/sessions/logout-all', { method: 'POST' }),
    onSuccess: (data) => qc.setQueryData(['sessions'], data),
  });
}

/**
 * DELETE /v1/users/me (ADR-169) — удаление аккаунта самим человеком.
 *
 * Требование Google Play к приложениям с аккаунтами: удаление должно быть
 * доступно ИЗ приложения (и объяснено на публичной странице —
 * `/legal/account-deletion`), а не только по письму в поддержку.
 *
 * 202 → токены на бэке уже недействительны. Сессию чистим ЗДЕСЬ, не дожидаясь
 * первого 401: иначе экран остался бы «залогиненным» с мёртвой парой, а тихий
 * refresh (`shared/api.ts`) сходил бы за новой и получил отказ. Кэш запросов
 * сбрасываем целиком — в нём лежат данные удалённого аккаунта.
 *
 * 409 `account_deletion_blocked` — удаление удерживается незавершёнными
 * договорами/открытыми спорами; числа для человека лежат в `context`.
 */
export function useDeleteAccount() {
  const qc = useQueryClient();
  const logout = useAuthStore((s) => s.logout);
  const resetActor = useActorStore((s) => s.reset);
  return useMutation({
    mutationFn: () => api.request<AccountDeletionResult>('/users/me', { method: 'DELETE' }),
    onSuccess: () => {
      logout();
      resetActor();
      qc.clear();
    },
  });
}

/** Числа из `context` 409-го `account_deletion_blocked`; `null` — ошибка другая. */
export function accountDeletionBlockedContext(error: unknown): AccountDeletionBlockedContext | null {
  if (!(error instanceof ApiError) || error.status !== 409 || error.code !== 'account_deletion_blocked') return null;
  const ctx = error.problem.context as Partial<AccountDeletionBlockedContext> | undefined;
  return {
    active_contracts: Number(ctx?.active_contracts ?? 0),
    open_disputes: Number(ctx?.open_disputes ?? 0),
  };
}

/** POST /users/me/drive/connect/callback — приём кода реального Drive-OAuth
 * (ADR-084, `EVIDENCE_DRIVE_PROVIDER=real`), инкрементальная авторизация ОТДЕЛЬНО
 * от входа (`useGoogleCallback`) — тот же приём idempotent, что и там. Ответ пустой,
 * статус подключения читается отдельным запросом (не заведён на фронте — вне
 * скоупа этого экрана, только сам callback). */
export function useDriveConnectCallback() {
  return useMutation({
    mutationFn: (input: DriveConnectCallbackInput) =>
      api.request<void>('/users/me/drive/connect/callback', { method: 'POST', body: input, idempotent: true }),
  });
}
