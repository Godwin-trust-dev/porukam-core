import { defineWorkspace } from 'vitest/config';

/**
 * Общие тайм-ауты для всех проектов монорепо: дефолтные 5000 мс «плавали»
 * под WSL при полном прогоне (jsdom + MSW + i18n на холодном старте).
 * Задаём один раз здесь, а не в каждом тесте через `asyncUtilTimeout`.
 */
const shared = { testTimeout: 20_000, hookTimeout: 20_000 };

// Единый прогон юнит/компонентных тестов по всем пакетам монорепо.
export default defineWorkspace([
  { extends: './packages/core/vitest.config.ts', root: './packages/core', test: shared },
  { extends: './web/vitest.config.ts', root: './web', test: shared },
]);
