import { createRequire } from 'node:module';
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

const require = createRequire(import.meta.url);
const { version } = require('./package.json') as { version: string };

export default defineConfig({
  plugins: [react()],
  // __APP_VERSION__ (DEV-15 §6) — тот же define, что и в vite.config.ts, но здесь без
  // vite-plugin-pwa (не нужен в тестах, и его виртуальный модуль тестов не касается).
  define: {
    __APP_VERSION__: JSON.stringify(version),
  },
  test: {
    name: 'web',
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/**/*.test.{ts,tsx}'],
    css: true,
  },
});
