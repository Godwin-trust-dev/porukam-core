/**
 * Онбординг GLOBAL У1 (DEV-auth-onboarding, ГВ.2) — чистая доменная логика,
 * без React/сети: «готов ли пользователь войти в приложение». Гард
 * (`web/src/features/auth/RequireGlobalOnboarding.tsx`) и страницы онбординга
 * зовут эту функцию, не переизобретают условие каждый на своей стороне.
 */
import type { CurrentUser, GlobalConsentState } from './api/types';

/**
 * Обязательные для входа в приложение шаги: согласия (§5 постановки — оба
 * обязательных согласия + выбор видимости) и @handle (§6 — обязателен, нужен
 * для ссылки-приглашения). Бэкап Drive — опционален, сюда не входит (§6:
 * «Позже» не блокирует).
 *
 * Источник признака «handle заявлен» — `CurrentUser.handle` (не
 * `profiles[].handle`): это ровно то поле, которое `POST /users/me/handle`
 * (`ProfileStep`, `useClaimHandle`, docs/tasks/
 * Задача_fix_web-profile-handle-real-api.md) реально пишет и которое
 * остальное приложение уже читает как канонический @handle владельца
 * (`OwnerProfilePage`, share-ссылка `/${me.handle}`) — то же поле для RU и
 * GLOBAL. `null` — ещё не назначен (свежий GLOBAL-аккаунт).
 */
export function isGlobalOnboardingComplete(
  me: Pick<CurrentUser, 'handle'> | undefined,
  consents: Pick<GlobalConsentState, 'completed'> | undefined,
): boolean {
  if (!me || !consents) return false;
  return consents.completed && Boolean(me.handle && me.handle.length > 0);
}
