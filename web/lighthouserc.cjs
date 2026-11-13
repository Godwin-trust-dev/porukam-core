/**
 * DEV-15 §9/§10 — критерий приёмки «Lighthouse видит установимую PWA»: `npm run lighthouse:pwa`
 * (из `web/`, через `@lhci/cli`). Собирает production-билд с VITE_API_MODE=real (без MSW —
 * см. отчёт DEV-15 §1, MSW и Workbox-SW не уживаются на одном scope) и гоняет Lighthouse
 * против него на локальном preview. Не часть CI — см. `docs/tasks/chore-web-ci.md`.
 *
 * Требует Node ≥18.20 (пакет `lighthouse` использует ESM import-attributes `with {type:"json"}`,
 * которого нет в Node 18.19 и ниже — упадёт `SyntaxError: Unexpected token 'with'` при старте).
 */
module.exports = {
  ci: {
    collect: {
      startServerCommand: 'npm run preview:pwa',
      startServerReadyPattern: 'Local:',
      startServerReadyTimeout: 60000,
      url: ['http://localhost:4174/'],
      numberOfRuns: 1,
      settings: {
        onlyCategories: ['pwa'],
      },
    },
    assert: {
      assertions: {
        'categories:pwa': ['error', { minScore: 0.9 }],
      },
    },
    upload: {
      target: 'filesystem',
      outputDir: './.lighthouseci',
    },
  },
};
