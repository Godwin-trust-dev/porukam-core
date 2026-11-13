import { create } from 'zustand';

const SESSION_KEY = 'porukam.guest_locale';

/**
 * Выбор языка гостя (DEV-16a §3) — «в памяти/сессии», не в профиле (профиля ещё нет).
 * `sessionStorage`, не `localStorage`: выбор гостя — на одну вкладку/сессию, не должен
 * пережить закрытие браузера и не должен утекать между разными гостевыми заходами.
 * Как только гость логинится — выбор едет в профиль (`useUpdateLocale`, `profile/api.ts`)
 * и эта память больше не источник истины.
 */
function readSession(): string | null {
  try {
    return sessionStorage.getItem(SESSION_KEY);
  } catch {
    // sessionStorage недоступен (приватный режим/SSR) — гость просто не запомнит выбор
    // между переходами в рамках сессии, это не критично (§4 "не блокер").
    return null;
  }
}

function writeSession(code: string): void {
  try {
    sessionStorage.setItem(SESSION_KEY, code);
  } catch {
    /* см. readSession */
  }
}

interface GuestLocaleState {
  /** `null` — выбора ещё не было, используем автоопределение (§3). */
  locale: string | null;
  setLocale: (code: string) => void;
}

export const useGuestLocaleStore = create<GuestLocaleState>((set) => ({
  locale: readSession(),
  setLocale: (code) => {
    writeSession(code);
    set({ locale: code });
  },
}));
