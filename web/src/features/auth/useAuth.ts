import { useEffect } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  CurrentUser,
  EmailCodeRequestResult,
  GoogleAuthorizeUrlResult,
  OtpRequestResult,
  TokenPair,
  VerificationLevel,
} from '@porukam/core';
import { api } from '../../shared/api';
import { useAuthStore } from './authStore';
import { useActorStore } from '../actor/actorStore';

/** Запрос OTP-кода на телефон. `/auth/otp/request` — личный эндпоинт (без
 * X-Acting-Profile). Реальный бэк отвечает 200 без тела — `undefined` в типе
 * честный, `dev_hint` есть только у мока. */
export function useRequestOtp() {
  return useMutation({
    mutationFn: (phone: string) =>
      api.request<OtpRequestResult | undefined>('/auth/otp/request', { method: 'POST', body: { phone } }),
  });
}

/** Проверка кода → пара токенов; следом грузим /users/me и заполняем профили актёра. */
export function useVerifyOtp() {
  const setTokens = useAuthStore((s) => s.setTokens);
  const setProfiles = useActorStore((s) => s.setProfiles);
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { phone: string; code: string }) => {
      const tokens = await api.request<TokenPair>('/auth/otp/verify', {
        method: 'POST',
        body: input,
        idempotent: true,
      });
      setTokens(tokens);
      const me = await api.request<CurrentUser>('/users/me');
      setProfiles(me.profiles);
      qc.setQueryData(['me'], me);
      return me;
    },
  });
}

/**
 * Запрос кода на e-mail (ADR-168). `/auth/email/request` — анонимный эндпоинт
 * (без X-Acting-Profile), отвечает 200 ВСЕГДА для синтаксически верного
 * адреса: есть ли такой аккаунт — не раскрываем. Тело пустое (`undefined` в
 * типе честный), `dev_hint` приходит только со стенда с фиксированным кодом.
 */
export function useRequestEmailCode() {
  return useMutation({
    mutationFn: (email: string) =>
      api.request<EmailCodeRequestResult | undefined>('/auth/email/request', {
        method: 'POST',
        body: { email },
      }),
  });
}

/**
 * Проверка кода из письма → пара токенов. Пост-логин путь ТОТ ЖЕ, что у OTP
 * (`useVerifyOtp`): `setTokens` с методом по умолчанию `'otp'` (не `'google'` —
 * гард `RequireGlobalOnboarding` спрашивает согласия только у Google-сессий),
 * следом `/users/me` и заполнение профилей актёра.
 */
export function useVerifyEmailCode() {
  const setTokens = useAuthStore((s) => s.setTokens);
  const setProfiles = useActorStore((s) => s.setProfiles);
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { email: string; code: string }) => {
      const tokens = await api.request<TokenPair>('/auth/email/verify', {
        method: 'POST',
        body: input,
        idempotent: true,
      });
      setTokens(tokens);
      const me = await api.request<CurrentUser>('/users/me');
      setProfiles(me.profiles);
      qc.setQueryData(['me'], me);
      return me;
    },
  });
}

/**
 * Real-API `/v1/users/me` отдаёт `verification_level` (enum), а экраны DEV-02
 * (Безопасность, DashboardRail, OwnerProfilePage) читают числовой
 * `verificationLevel` 0–3 — поле мок-контракта, которого на бэке нет:
 * в проде выводилось «Верификация / 3». Выводим число из enum'а здесь,
 * одной точкой, поверх любого источника данных `['me']` (в т.ч. setQueryData
 * после логина). `orgs` бэк тоже не отдаёт — юрлица берутся из `profiles`.
 */
const VERIFICATION_LEVEL_NUM: Record<VerificationLevel, CurrentUser['verificationLevel']> = {
  none: 0,
  phone: 1,
  basic: 2,
  verified: 3,
};

export function normalizeCurrentUser(me: CurrentUser): CurrentUser {
  if (typeof me.verificationLevel === 'number') return me;
  return { ...me, verificationLevel: VERIFICATION_LEVEL_NUM[me.verification_level] ?? 0 };
}

export function useCurrentUser() {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const setProfiles = useActorStore((s) => s.setProfiles);
  const query = useQuery({
    queryKey: ['me'],
    queryFn: () => api.request<CurrentUser>('/users/me'),
    enabled: isAuthenticated,
    select: normalizeCurrentUser,
    // person-Profile создаётся АСИНХРОННО (outbox-событие согласий →
    // apps.profiles.subscriber, не в транзакции логина): пока профилей нет —
    // мягкий поллинг, иначе свежий пользователь застревает без myRole на
    // подписании/этапе (§E-смоук 2026-08-18). Появились — поллинг выключен.
    refetchInterval: (q) => ((q.state.data?.profiles.length ?? 1) === 0 ? 3000 : false),
  });
  // Актёр-стор — зеркало последнего /users/me, не только снимка на логине:
  // person-Profile у свежего пользователя создаётся ЛЕНИВО (шаг приватности /
  // первая сделка), и до этого фикса профили, появившиеся после логина, в
  // стор не попадали — SigningPage/StagePage не находили myRole и прятали
  // все действия (§E-смоук 2026-08-18). setProfiles сохраняет уже выбранный
  // activeProfileId.
  const profiles = query.data?.profiles;
  useEffect(() => {
    if (profiles && profiles.length > 0) setProfiles(profiles);
  }, [profiles, setProfiles]);
  return query;
}

/**
 * id текущего пользователя ТОЛЬКО из кэша `['me']`, без запроса.
 *
 * `useCurrentUser` зеркалит `me.profiles` в актёр-стор (`setProfiles`) —
 * побочный эффект, который нужен оболочке, но не компоненту, которому от
 * пользователя нужен ОДИН `id` (напр. «чьё это событие в хронике»): лишний
 * вызов переопределял бы выбранного актёра. Кэш заполняет оболочка
 * (`useLocaleResolution`/`ShellLayout`); пока он пуст — честный `null`.
 */
export function useCurrentUserId(): string | null {
  const { data } = useQuery({
    queryKey: ['me'],
    queryFn: () => api.request<CurrentUser>('/users/me'),
    enabled: false,
  });
  return data?.id ?? null;
}

/**
 * Второй способ входа (GLOBAL У1, DEV-auth-onboarding §3, ADR-071) — анонимно,
 * бэк отдаёт `authorize_url` + `state` (PKCE на сервере). В моке
 * `authorize_url` ведёт на внутренний роут выбора аккаунта, не на реальный
 * Google (реальный OAuth — Ф6).
 */
export function useGoogleAuthorizeUrl() {
  return useMutation({
    mutationFn: () => api.request<GoogleAuthorizeUrlResult>('/auth/google/authorize-url'),
  });
}

/** POST /auth/google/callback {code, state} — тот же контур выдачи токенов и
 * заполнения актёра, что `useVerifyOtp` (ADR-071: вход неотличим от OTP). */
export function useGoogleCallback() {
  const setTokens = useAuthStore((s) => s.setTokens);
  const setProfiles = useActorStore((s) => s.setProfiles);
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { code: string; state: string }) => {
      const tokens = await api.request<TokenPair>('/auth/google/callback', {
        method: 'POST',
        body: input,
        idempotent: true,
      });
      setTokens(tokens, 'google');
      const me = await api.request<CurrentUser>('/users/me');
      setProfiles(me.profiles);
      qc.setQueryData(['me'], me);
      return me;
    },
  });
}
