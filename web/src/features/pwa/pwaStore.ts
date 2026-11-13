import { create } from 'zustand';

type UpdateSwFn = (reloadPage?: boolean) => Promise<void>;

/** Нестандартное событие Chromium — в lib.dom его нет. */
export interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
}

interface PwaState {
  /** Новый SW установлен и ждёт активации (`registerType: 'prompt'`) — показать `UpdateToast`. */
  needRefresh: boolean;
  /** Оболочка закэширована и доступна офлайн (первая установка SW). */
  offlineReady: boolean;
  updateSW: UpdateSwFn | null;
  /**
   * Перехваченный `beforeinstallprompt`. Живёт в сторе, а не в `useInstall`, потому что
   * браузер стреляет это событие ОДИН раз и рано — обычно до того, как React смонтирует
   * `ShellLayout`. Слушатель, повешенный в `useEffect`, его попросту не застаёт, и кнопка
   * установки навсегда остаётся мёртвой (жалоба владельца 05.09, Samsung S22 Ultra).
   * Перехват — в `installPromptCapture.ts`, на старте `main.tsx`.
   */
  installPrompt: BeforeInstallPromptEvent | null;
  setNeedRefresh: (v: boolean) => void;
  setOfflineReady: (v: boolean) => void;
  setUpdateSW: (fn: UpdateSwFn | null) => void;
  setInstallPrompt: (e: BeforeInstallPromptEvent | null) => void;
}

/**
 * Мост между `virtual:pwa-register` (см. `swRegistration.ts`) и UI (`UpdateToast`).
 * Регистрация происходит вне React (после `load`), стор — единственный канал в компоненты.
 */
export const usePwaStore = create<PwaState>((set) => ({
  needRefresh: false,
  offlineReady: false,
  updateSW: null,
  installPrompt: null,
  setNeedRefresh: (v) => set({ needRefresh: v }),
  setOfflineReady: (v) => set({ offlineReady: v }),
  setUpdateSW: (fn) => set({ updateSW: fn }),
  setInstallPrompt: (e) => set({ installPrompt: e }),
}));
