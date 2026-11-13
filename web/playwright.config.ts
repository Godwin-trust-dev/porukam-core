import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright smoke (ТЗ §15, критерий приёмки 3).
 * Против мок-API (VITE_API_MODE=mock) на preview-сборке.
 * Chromium берётся из системного пути песочницы, если задан PW executablePath.
 */
/**
 * Порт preview-сервера — из окружения (`PW_PORT`), дефолт 4173.
 * Зачем: при параллельных ворктри 4173 бывает занят ЧУЖОЙ сборкой, и с
 * `reuseExistingServer: true` Playwright молча гонял тесты по чужому коду.
 * Теперь порт задаётся снаружи (`PW_PORT=4187 npm run test:e2e -w web`), а
 * сервер НИКОГДА не переиспользуется — Playwright поднимает свою сборку и
 * падает, если порт занят (`--strictPort`), вместо тихого ложного прогона.
 */
const PORT = Number(process.env.PW_PORT) || 4173;

export default defineConfig({
  testDir: './tests/e2e',
  // DEV-15 · PWA-специфика (SW/установка/офлайн) живёт в своём конфиге
  // (playwright.pwa.config.ts, отдельный build+preview без MSW) — не дублируем здесь.
  testIgnore: '**/pwa/**',
  timeout: 30_000,
  expect: { timeout: 7_000 },
  fullyParallel: false,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'off',
    screenshot: 'off',
    // DEV-16a §3 — гость без сохранённого выбора определяется по navigator.language
    // (useLocaleResolution). Большинство e2e здесь писались, когда рантайм был
    // безусловно RU (до переключателя языка), и предполагают русский текст — фиксируем
    // локаль браузера на ru-RU, чтобы это продолжало отражать реального русскоязычного
    // визитёра, а не дефолт Chromium (en-US). Тесты самого переключателя
    // (language-switcher.spec.ts) при необходимости переопределяют `test.use({ locale })`.
    locale: 'ru-RU',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: process.env.PW_CHROMIUM
          ? { executablePath: process.env.PW_CHROMIUM }
          : {},
      },
    },
  ],
  webServer: {
    // `vite preview` вызывается напрямую (не через `npm run preview`): у скрипта
    // уже зашит `--port 4173`, а повтор флага cac сложил бы в массив.
    command: `npm run build && npx vite preview --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: { VITE_API_MODE: 'mock' },
  },
});
