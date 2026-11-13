/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Режим API: 'mock' включает MSW-слой. Переключение на реальный API — в Ф6. */
  readonly VITE_API_MODE?: 'mock' | 'real';
  /**
   * DEV-15 · только сборка `npm run preview:pwa` (playwright.pwa.config.ts, lighthouserc.cjs):
   * открывает `window.__pwaDebug.setAuthenticated()` — там нет ни MSW, ни реального бэкенда,
   * тесты заводят сессию напрямую через стор. В боевой Ф6-сборке не выставляется.
   */
  readonly VITE_PWA_E2E?: '1';
  /**
   * docs/tasks/Задача_feat_web-global-entry.md — телефонный/OTP-вход на время
   * ГЛОБАЛЬНОЙ волны (только Google) спрятан за этим флагом, НЕ удалён.
   * По умолчанию (не выставлен — dev/тесты/e2e/Storybook) — включён; прод-
   * образ (конфиг nginx) собирается с '0'.
   */
  readonly VITE_PHONE_LOGIN_ENABLED?: '0' | '1';
  /**
   * ADR-168 — вход/регистрация по e-mail кодом (`/login/email`). В отличие от
   * телефонного дефолт ВКЛЮЧЁН везде, включая прод-образ: переменная не
   * выставляется нигде, `'0'` остаётся аварийным рубильником.
   */
  readonly VITE_EMAIL_LOGIN_ENABLED?: '0' | '1';
  /** Фич-флаги выключенных разделов через запятую (web/src/shared/features.ts): chat,search,groups,organizations,socialLinks. */
  readonly VITE_FEATURES?: string;
  /** Ссылки соцсетей (отсмотр 22.08) — блок показывается при флаге socialLinks и непустой ссылке. */
  readonly VITE_SOCIAL_INSTAGRAM?: string;
  readonly VITE_SOCIAL_TELEGRAM?: string;
  readonly VITE_SOCIAL_FACEBOOK?: string;
  readonly VITE_SOCIAL_LINKEDIN?: string;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}

/** Версия приложения (DEV-15 §6) — инжектится `define` из `web/package.json` в vite.config.ts. */
declare const __APP_VERSION__: string;
