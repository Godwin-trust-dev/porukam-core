/**
 * docs/tasks/Задача_feat_web-global-entry.md — на время ГЛОБАЛЬНОЙ волны
 * вход только через Google (`/welcome`); телефонный/OTP-вход (`/login`)
 * спрятан, НЕ удалён — чтобы вернуть SMS позже без переписывания.
 *
 * Флаг, не удаление кода: по умолчанию (переменная не выставлена — dev-
 * сервер, vitest, Playwright, Storybook) вход по телефону ВКЛЮЧЁН, как и
 * раньше. Прод-образ (конфиг nginx, ARG
 * VITE_PHONE_LOGIN_ENABLED) собирается с '0' — тот же ARG→ENV-приём, что
 * VITE_API_MODE (docs/tasks/Задача_fix_web-disable-prod-mocks.md).
 */
// Чистая функция, не читающая import.meta.env напрямую — юнит-тестируема
// без стаба env (тот же приём, что detectGuestLocale в features/locale).
export function isPhoneLoginEnabled(flag: string | undefined): boolean {
  return flag !== '0';
}

export const PHONE_LOGIN_ENABLED = isPhoneLoginEnabled(import.meta.env.VITE_PHONE_LOGIN_ENABLED);
