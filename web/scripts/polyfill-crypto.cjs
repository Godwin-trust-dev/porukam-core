/**
 * DEV-15 · Node ≤18 не имеет глобального `crypto` (стабилен с Node 20) — от него зависит
 * `serialize-javascript` (через `@rollup/plugin-terser`, транзитивно из `workbox-build`,
 * которым пользуется `vite-plugin-pwa` при сборке service worker'а): без полифилла
 * `npm run build`/`preview:pwa` падает `ReferenceError: crypto is not defined` уже на
 * Node 18, до самой минификации. На Node ≥20 условие ложно — полифилл не трогает рантайм.
 * Подключается через NODE_OPTIONS=--require (см. package.json), не в самом vite.config.ts —
 * нужен ДО загрузки транзитивных зависимостей плагина, а не в момент выполнения его кода.
 */
if (typeof globalThis.crypto === 'undefined') {
  globalThis.crypto = require('node:crypto').webcrypto;
}
