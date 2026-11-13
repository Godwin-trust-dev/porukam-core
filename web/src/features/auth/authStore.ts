import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import type { TokenPair } from '@porukam/core';

export type LoginMethod = 'otp' | 'google';

/**
 * Хранилище сессии (ТЗ §13.2). Пара токенов переживает перезагрузку вкладки:
 * без этого любой F5 обнулял стор, и `RequireAuth` уводил человека на экран
 * входа (отсмотр прода 2026-08-21). Хранилище — `localStorage` под ключом
 * `porukam.auth`: access живёт 15 минут, refresh ротируется клиентом по 401
 * (`shared/api.ts`), при отклонённом refresh — `logout()` чистит и память,
 * и хранилище. Секретов приложения в бандле по-прежнему нет.
 *
 * `loginMethod` (DEV-auth-onboarding, ГВ.2) — явный сигнал для
 * `RequireGlobalOnboarding`: НЕ читать `me.identity?.provider === 'google'`
 * для этой цели — то же поле уже занято у RU-мока (`data.ts` — витрина
 * `IdentityCard` в DEV-09, к реальному входу отношения не имеет), и гард по
 * нему ошибочно уводил бы всех OTP-пользователей в онбординг GLOBAL.
 * Сохраняется вместе с токенами — иначе после F5 Google-сессия теряла бы гард.
 */
interface AuthState {
  access: string | null;
  refresh: string | null;
  isAuthenticated: boolean;
  loginMethod: LoginMethod | null;
  /** `method` по умолчанию `'otp'` — существующие вызовы (RU, тесты) не меняются. */
  setTokens: (tokens: TokenPair, method?: LoginMethod) => void;
  logout: () => void;
}

export const AUTH_STORAGE_KEY = 'porukam.auth';

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      access: null,
      refresh: null,
      isAuthenticated: false,
      loginMethod: null,
      setTokens: (tokens, method = 'otp') =>
        set({ access: tokens.access, refresh: tokens.refresh, isAuthenticated: true, loginMethod: method }),
      logout: () => set({ access: null, refresh: null, isAuthenticated: false, loginMethod: null }),
    }),
    {
      name: AUTH_STORAGE_KEY,
      storage: createJSONStorage(() => localStorage),
      partialize: (s) => ({
        access: s.access,
        refresh: s.refresh,
        isAuthenticated: s.isAuthenticated,
        loginMethod: s.loginMethod,
      }),
    },
  ),
);

// ADR-107: вкладки делят один refresh, а бэк ротирует его с блэклистом
// (ROTATE_REFRESH_TOKENS + BLACKLIST_AFTER_ROTATION). Запись из соседней
// вкладки (новая пара, logout) подхватывается здесь; гонку «успел отправить
// старый» закрывает повтор в ApiClient.doRefresh. В jsdom/SSR `window` может
// отсутствовать.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key === AUTH_STORAGE_KEY) void useAuthStore.persist.rehydrate();
  });
}
