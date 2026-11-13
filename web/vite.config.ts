import { createRequire } from 'node:module';
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { NAVIGATE_FALLBACK_DENYLIST } from './src/features/pwa/navigateFallbackDenylist';

const require = createRequire(import.meta.url);
const { version } = require('./package.json') as { version: string };

// Мок-развилка та же, что в web/src/main.tsx: без переменной — 'mock' (web/CLAUDE.md §3).
// Прод-образ собирается с VITE_API_MODE=real (конфиг nginx, ARG).
const isMockBuild = (process.env.VITE_API_MODE ?? 'mock') === 'mock';

/**
 * `public/mockServiceWorker.js` (сгенерирован `npm run msw:init`) нужен ТОЛЬКО мок-режиму,
 * но лежит в `public/` и потому копировался в `dist` любой сборки — включая боевую. Хуже
 * того, он подходил под `globPatterns: **\/*.js` и попадал в PRECACHE-манифест: worker MSW
 * скачивался и кэшировался у каждого пользователя прода (проверено на dist от 01.09 —
 * запись `mockServiceWorker.js` в sw.js присутствовала). Активироваться он не мог (MSW
 * стартует только в мок-режиме), но это лишний вес и лишняя запись precache, падение
 * которой ломает установку SW целиком.
 *
 * `enforce: 'post'` + позиция ПОСЛЕ VitePWA в массиве плагинов: `closeBundle` этого плагина
 * отрабатывает после генерации sw.js, поэтому удаление файла не может разъехаться с
 * манифестом — из манифеста он уже исключён через `globIgnores` ниже.
 */
function dropMockServiceWorker(): Plugin {
  return {
    name: 'porukam-drop-msw',
    enforce: 'post',
    apply: 'build',
    closeBundle() {
      if (isMockBuild) return;
      // __dirname в ESM-конфиге не существует (файл уже на import.meta — см.
      // createRequire выше), а cwd при `npm run build -w web` — корень монорепо.
      rmSync(fileURLToPath(new URL('dist/mockServiceWorker.js', import.meta.url)), { force: true });
    },
  };
}

export default defineConfig({
  plugins: [
    react(),
    // DEV-15 · PWA-обвязка. Регистрация SW — вручную из main.tsx (см. features/pwa/swRegistration.ts),
    // ТОЛЬКО когда VITE_API_MODE !== 'mock' (единственная развилка с MSW, отчёт DEV-15 §1) —
    // injectRegister: false отключает авто-инъекцию скрипта регистрации в index.html.
    VitePWA({
      registerType: 'prompt',
      injectRegister: false,
      devOptions: { enabled: false },
      manifestFilename: 'manifest.webmanifest',
      includeAssets: ['icons/apple-touch-icon.png', 'icons/favicon-32.png'],
      manifest: {
        // DEV-16 §7 — «lang в manifest по выбранной локали при установке, если просто —
        // иначе en, не блокер». `manifest.webmanifest` — ОДИН статический файл, собранный
        // на этапе сборки (vite-plugin-pwa) — настоящий per-пользователь `lang` потребовал
        // бы либо нескольких файлов манифеста, переключаемых JS ДО `beforeinstallprompt`,
        // либо серверной генерации — не «просто». Поэтому `description` и `lang` остаются
        // русскими: переводить весь манифест на лету всё равно нечем.
        // 31.08 — решение владельца: `name`/`short_name` — латиницей `Porukam`. Это ИМЯ
        // БРЕНДА, а не перевод, поэтому оно одинаково на всех 29 языках и не зависит от
        // `lang`; подпись иконки на домашнем экране и заголовок вкладки (web/index.html)
        // должны совпадать буква в букву, иначе установленное приложение и вкладка
        // выглядят как два разных продукта.
        name: 'Porukam',
        short_name: 'Porukam',
        // «Защищённая оплата» здесь стояла с первой сборки и обещала эскроу,
        // которого у продукта нет: платформа не держит деньги, расчёты идут
        // напрямую между сторонами (витрина Play, абзац «Оплата, привязанная к
        // результату»; FAQ «Проходят ли деньги через платформу? — Нет»).
        // Формулировка выровнена с витриной 29.10.2026.
        description: 'Договоры между людьми и бизнесом — по-честному: этапы, приёмка по чек-листу, оплата за результат.',
        start_url: '/?src=pwa',
        // Идентичность установленного приложения. Явное `id` — ровно то значение, каким
        // браузер и так считает неявное (по спецификации оно равно `start_url`): у тех, кто
        // уже поставил приложение, ничего не меняется, а любая будущая правка `start_url`
        // (метка источника, язык) больше не превратит обновление во «второе приложение».
        id: '/?src=pwa',
        scope: '/',
        display: 'standalone',
        lang: 'ru',
        dir: 'ltr',
        theme_color: '#16283C', // --pr-ink (packages/ui/src/styles/tokens.css)
        background_color: '#FBF6EE', // --pr-cream
        icons: [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: '/icons/icon-512-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // 'development' — сам SW НЕ минифицируется терсером: workbox-build иначе тянет
        // rollup-terser → serialize-javascript, которому нужен глобальный `crypto` (стабилен
        // только с Node 20; в Node 18 падает `ReferenceError: crypto is not defined`).
        // Наш SW маленький — экономия от минификации незначима, а от версии Node не зависим.
        mode: 'development',
        // Web Push (ADR-110): обработчики push/notificationclick — отдельным
        // скриптом поверх generateSW (свой injectManifest-SW не заводим).
        importScripts: ['push-sw.js'],
        // Оболочка (§1): HTML/JS/CSS/шрифты/иконки — precache; навигационный fallback офлайн.
        globPatterns: ['**/*.{js,css,html,woff2,png,svg,ico}'],
        // Worker MSW — не часть оболочки; в боевой сборке файл ещё и удаляется
        // (dropMockServiceWorker ниже), в мок-сборке остаётся, но precache ему не нужен.
        // Пререндеренные публичные страницы (ADR-195) — НЕ часть оболочки:
        // `dist/landing.html` и 144 файла `<язык>/<страница>/index.html`
        // подходят под `globPatterns` выше и уехали бы в precache целиком —
        // почти полмегабайта маркетинговых страниц на 29 языках, которые
        // установленному приложению не нужны вовсе (оно рисует те же страницы
        // клиентским роутингом). `**/*/*.html` отсекает только ВЛОЖЕННЫЕ html,
        // корневой `index.html` (оболочка SPA) в precache остаётся.
        // Медиа публичного контура (ADR-195): ролик, его постер и 29 файлов
        // субтитров. Постер подходит под `**/*.png` выше и уехал бы в precache
        // установленного приложения, которому витринный ролик не нужен вовсе;
        // сам `.webm` под globPatterns не подходит, но держим всю папку одним
        // правилом — иначе следующий добавленный формат снова просочится.
        globIgnores: [
          '**/mockServiceWorker.js',
          '**/*/*.html',
          'landing.html',
          'media/**',
        ],
        navigateFallback: '/index.html',
        // Пути бэкенда (в т.ч. `/a/<token>` — ссылка на архив, ADR-139 §7) —
        // мимо оболочки, иначе запрос не уходит в сеть вовсе. Список и разбор
        // инцидента 03.09 — в src/features/pwa/navigateFallbackDenylist.ts,
        // покрыт tests/navigateFallbackDenylist.test.ts.
        navigateFallbackDenylist: [...NAVIGATE_FALLBACK_DENYLIST],
        runtimeCaching: [
          {
            // API GET — NetworkFirst (кэш как fallback офлайн, §3 «показано из кэша»).
            urlPattern: ({ url, request }) => url.pathname.startsWith('/v1/') && request.method === 'GET',
            handler: 'NetworkFirst',
            options: {
              cacheName: 'pwa-api-cache',
              networkTimeoutSeconds: 5,
              cacheableResponse: { statuses: [0, 200] },
              expiration: { maxEntries: 100, maxAgeSeconds: 60 * 60 * 24 },
            },
          },
          {
            // Статика JS/CSS — StaleWhileRevalidate.
            urlPattern: ({ request }) => request.destination === 'script' || request.destination === 'style',
            handler: 'StaleWhileRevalidate',
            options: { cacheName: 'pwa-static-cache' },
          },
          {
            // Иконки/шрифты — CacheFirst (не меняются между релизами).
            urlPattern: ({ request }) => request.destination === 'image' || request.destination === 'font',
            handler: 'CacheFirst',
            options: {
              cacheName: 'pwa-assets-cache',
              expiration: { maxEntries: 60, maxAgeSeconds: 60 * 60 * 24 * 30 },
            },
          },
        ],
      },
    }),
    dropMockServiceWorker(),
  ],
  define: {
    __APP_VERSION__: JSON.stringify(version),
  },
  server: { port: 5173 },
  // `strictPort`: при занятом 4173 vite молча уезжал на следующий свободный —
  // а это 4174, порт PWA-e2e (`playwright.pwa.config.ts`). Человек смотрел
  // ЧУЖУЮ сборку и не знал об этом. Лучше падение с занятым портом.
  preview: { port: 4173, strictPort: true },
});
