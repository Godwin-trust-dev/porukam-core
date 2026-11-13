import { defineConfig, devices } from '@playwright/test';

/**
 * DEV-15 · PWA e2e (install / offline / update / Lighthouse-adjacent) — ОТДЕЛЬНЫЙ конфиг
 * от `playwright.config.ts` (запуск: `npm run test:e2e:pwa`, порт по умолчанию 4174).
 *
 * Почему отдельно: основной e2e-набор всегда собирается с VITE_API_MODE=mock — MSW держит
 * scope "/" для перехвата /v1/*. Workbox/PWA service worker на том же scope увёл бы контроль
 * над fetch у MSW и сломал бы все мок-сценарии. Поэтому здесь — отдельная сборка с
 * VITE_API_MODE=real (без MSW), где PWA SW действительно регистрируется и кэширует (см.
 * features/pwa/swRegistration.ts и отчёт DEV-15 §1). Данных с реального бэкенда ещё нет
 * (Ф6), поэтому тесты здесь бьют по установке/офлайн-оболочке/обновлению — не по доменным
 * сценариям (те — в основном наборе, на моках).
 */
/**
 * Порт preview-сервера — из окружения (`PW_PWA_PORT`), дефолт 4174; как
 * `PW_PORT` в основном конфиге. Сервер никогда не переиспользуется: при
 * параллельных ворктри чужой preview на том же порту молча подменял сборку,
 * а SW/офлайн-сценарии тем более обязаны идти по СВОЕЙ сборке.
 */
const PORT = Number(process.env.PW_PWA_PORT) || 4174;

export default defineConfig({
  testDir: './tests/e2e/pwa',
  timeout: 30_000,
  expect: { timeout: 7_000 },
  fullyParallel: false,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report-pwa' }]],
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'off',
    screenshot: 'off',
    // Как в основном playwright.config.ts: спеки install/offline/update проверяют
    // русские строки, а с DEV-16a язык гостя берётся из navigator.language —
    // дефолт Chromium (en-US) давал английский UI, и все 7 текстовых проверок
    // сьюта таймаутились (№11 отсмотра 2026-08-18). Фиксируем ru-RU.
    locale: 'ru-RU',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {},
      },
    },
  ],
  webServer: {
    // Не через `npm run preview:pwa`: там зашит `--port 4174`, а повтор флага
    // cac сложил бы в массив. Режим сборки (real + PWA_E2E, без MSW) задаём
    // через `env` — он же долетает и до preview.
    command: `npm run build && npx vite preview --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: { VITE_API_MODE: 'real', VITE_PWA_E2E: '1' },
  },
});
