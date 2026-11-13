import type { Preview } from '@storybook/react';
import { pseudoize } from '@porukam/i18n';
import '../src/styles/tokens.css';
import '../src/styles/fonts.css';

type StoryDir = 'ltr' | 'rtl' | 'pseudo';

/**
 * DEV-16c §5 — псевдолокаль как стоячий гейт: здесь она даёт витрину, «псевдолокаль как
 * стоячий гейт для CI» — сам e2e-прогон (`web/tests/e2e/pseudolocale.spec.ts`, DEV-16 §1).
 * Пропускаем нестроковые пропы (children/callbacks/объекты) — псевдолокализуем только
 * листовые строковые пропы историй (текст, не структуру).
 */
function pseudoizeArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    out[key] = typeof value === 'string' ? pseudoize(value) : value;
  }
  return out;
}

const preview: Preview = {
  parameters: {
    controls: { matchers: { color: /(background|color)$/i, date: /Date$/i } },
    backgrounds: {
      default: 'cream',
      values: [
        { name: 'cream', value: '#FBF6EE' },
        { name: 'ink (dark UI)', value: '#16283C' },
        { name: 'white', value: '#FFFFFF' },
      ],
    },
    options: {
      storySort: { order: ['Основы', 'Раскладка', 'Компоненты'] },
    },
    // DEV-19 §8: приёмочные ширины прогона — 360 · 768 · 1024 · 1440.
    // 1023 добавлен рядом с 1024 намеренно: именно на этой паре видно, что
    // мобильная стопка и десктопная раскладка переключаются там, где обещано.
    viewport: {
      viewports: {
        w360: { name: '360 — телефон', styles: { width: '360px', height: '780px' } },
        w768: { name: '768 — планшет', styles: { width: '768px', height: '1024px' } },
        w1023: { name: '1023 — последний «мобильный»', styles: { width: '1023px', height: '900px' } },
        w1024: { name: '1024 — первый десктопный', styles: { width: '1024px', height: '900px' } },
        w1440: { name: '1440 — десктоп', styles: { width: '1440px', height: '900px' } },
      },
    },
  },
  // DEV-16c §5 ⭐ — глобальный тумблер dir (ltr/rtl/pseudo): смотреть любой компонент в RTL
  // без переключения языка интерфейса и без реального ar/fa/he-контента.
  globalTypes: {
    dir: {
      name: 'Direction',
      description: 'RTL-enablement аудит (DEV-16c §5) — LTR / RTL (ar-fa-he-фундамент) / псевдолокаль (bidi-стресс, en-XA-подобная)',
      toolbar: {
        icon: 'transfer',
        items: [
          { value: 'ltr', title: 'LTR' },
          { value: 'rtl', title: 'RTL (ar/fa/he)' },
          { value: 'pseudo', title: 'Pseudo (en-XA, bidi-стресс)' },
        ],
        dynamicTitle: true,
      },
    },
  },
  decorators: [
    (Story) => {
      document.body.style.fontFamily = "'Inter', system-ui, sans-serif";
      return Story();
    },
    (Story, context) => {
      const dir: StoryDir = (context.globals.dir as StoryDir | undefined) ?? 'ltr';
      // Псевдолокаль — не RTL: та же логика, что `en-XA` (packages/i18n/src/pseudo.ts),
      // растягивает и «утяжеляет» латиницей строковые пропы истории, направление — LTR.
      const rendered = dir === 'pseudo' ? Story({ args: pseudoizeArgs(context.args) }) : Story();
      return (
        <div dir={dir === 'rtl' ? 'rtl' : 'ltr'} data-storybook-dir={dir} style={{ minHeight: '100%' }}>
          {rendered}
        </div>
      );
    },
  ],
};

export default preview;
