/**
 * Вход/регистрация по e-mail шестизначным кодом (ADR-168, решение владельца
 * 06.09.2026): «вход только через Google» смягчён до «Google + почта».
 *
 * Флаг сборки по образцу `phoneLoginFlag.ts`, но с ОБРАТНЫМ дефолтом:
 * e-mail-вход включён везде, где переменная не выставлена (dev-сервер,
 * vitest, Playwright, Storybook И прод-образ) — прятать его незачем, это
 * полноценный второй способ входа. Флаг оставлен как рубильник: `'0'` убирает
 * кнопку с `/welcome` и уводит маршрут `/login/email` на `/welcome`
 * (тот же приём, что у телефонного входа), если e-mail-канал придётся
 * выключить без пересборки логики.
 */
// Чистая функция, не читающая import.meta.env напрямую — юнит-тестируема
// без стаба env (тот же приём, что isPhoneLoginEnabled).
export function isEmailLoginEnabled(flag: string | undefined): boolean {
  return flag !== '0';
}

export const EMAIL_LOGIN_ENABLED = isEmailLoginEnabled(import.meta.env.VITE_EMAIL_LOGIN_ENABLED);
