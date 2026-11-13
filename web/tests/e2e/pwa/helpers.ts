import { expect, type Page } from '@playwright/test';

/**
 * DEV-15 e2e (playwright.pwa.config.ts) — сборка без MSW и без реального бэкенда (Ф6 ещё не
 * готов), поэтому OTP/Google-вход недоступен. Сессия заводится напрямую через `authStore`
 * (см. `main.tsx` → `window.__pwaDebug.setAuthenticated`, доступно только при VITE_PWA_E2E=1).
 * Токены — только в памяти (см. `authStore.ts`), поэтому НЕ делаем `page.reload()`, а уходим
 * с /login в SPA-роутинге (pushState + popstate), как и остальные e2e-хелперы репозитория.
 */
export async function authenticate(page: Page): Promise<void> {
  await page.goto('/');
  await page.waitForFunction(() => Boolean((window as unknown as { __pwaDebug?: { setAuthenticated?: () => void } }).__pwaDebug?.setAuthenticated));
  await page.evaluate(() => {
    (window as unknown as { __pwaDebug: { setAuthenticated: () => void } }).__pwaDebug.setAuthenticated();
    window.history.pushState({}, '', '/');
    window.dispatchEvent(new PopStateEvent('popstate'));
  });
  await expect(page).toHaveURL('/');
}

/** Внутренняя SPA-навигация (без полной перезагрузки) — тот же приём, что и в остальных e2e. */
export async function openPath(page: Page, path: string): Promise<void> {
  await page.evaluate((p) => {
    window.history.pushState({}, '', p);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, path);
}
