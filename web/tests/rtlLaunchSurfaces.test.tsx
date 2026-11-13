import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nextProvider } from 'react-i18next';
import { createI18n, loadLocaleResources, useHtmlLangDir } from '@porukam/i18n';
import { WelcomePage } from '../src/pages/auth/WelcomePage';

/**
 * Проверка (не переделка) RTL на стартовых поверхностях — решение владельца
 * 17.08.2026: «RTL-вёрстка готова, быстро проверь, что стартовые экраны реально
 * зеркалятся на одном RTL-языке (напр. ar)».
 *
 * Фундамент RTL сделан в ADR-079 §2 (логические CSS-свойства + `useHtmlLangDir`);
 * здесь фиксируем, что стартовые экраны и юр-документ этим фундаментом реально
 * пользуются, и что арабский больше не выключен в каталоге языков.
 */

function LangDirSync(): null {
  useHtmlLangDir();
  return null;
}

async function renderWelcome(lng: string) {
  const i18n = createI18n(lng);
  await loadLocaleResources(i18n, lng);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <I18nextProvider i18n={i18n}>
        <LangDirSync />
        <MemoryRouter initialEntries={['/welcome']}>
          <WelcomePage />
        </MemoryRouter>
      </I18nextProvider>
    </QueryClientProvider>,
  );
}

const LAUNCH_SURFACE_CSS = [
  'web/src/pages/auth/AuthScreen.module.css',
  'web/src/pages/onboarding/OnboardingLayout.module.css',
  'packages/ui/src/components/Sheet.module.css',
  'packages/ui/src/components/LegalDocumentSheet.module.css',
  'packages/ui/src/components/MarkdownDocument.module.css',
  'packages/ui/src/components/LocaleRow.module.css',
  'packages/ui/src/components/MachineTranslationMark.module.css',
];

// Физические направления, которые НЕ зеркалятся при `dir="rtl"`; логические
// эквиваленты (`*-inline-start/end`, `inset-inline-*`, `text-align: start/end`)
// зеркалятся сами. Границы слова важны: `border-inline-start` не должен
// матчиться как `border-left`.
const PHYSICAL_DIRECTION = /(margin|padding|border)-(left|right)\b|(^|[\s;{])(left|right)\s*:|text-align:\s*(left|right)\b/m;

describe('RTL на стартовых поверхностях (проверка, ADR-079 §2)', () => {
  afterEach(() => {
    document.documentElement.removeAttribute('dir');
    document.documentElement.removeAttribute('lang');
  });

  it('арабский переключает <html dir> на rtl и ставит lang', async () => {
    await renderWelcome('ar');

    expect(document.documentElement.lang).toBe('ar');
    expect(document.documentElement.dir).toBe('rtl');
  });

  it('латиница остаётся ltr (переключение работает в обе стороны)', async () => {
    await renderWelcome('es');

    expect(document.documentElement.lang).toBe('es');
    expect(document.documentElement.dir).toBe('ltr');
  });

  it('стартовый экран на арабском переведён полностью, а не по EN-фолбэку', async () => {
    await renderWelcome('ar');

    expect(screen.getByRole('button', { name: 'المتابعة باستخدام Google' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'شروط الاستخدام' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'سياسة الخصوصية' })).toBeInTheDocument();
  });

  it('юр-документ на арабском открывается на арабском (а не английский оригинал)', async () => {
    const user = userEvent.setup();
    await renderWelcome('ar');

    await user.click(screen.getByRole('button', { name: 'سياسة الخصوصية' }));

    const dialog = await screen.findByRole('dialog');
    // Мок юр-документов знает только en/ru/es, поэтому по `ar` честно приходит
    // EN-фолбэк — и интерфейс обязан об этом сказать, а не выдать английский
    // текст за перевод (реальные пакеты `ar` документ несут, см. localePacks).
    expect(within(dialog).getByRole('status')).toHaveTextContent(/لم تُترجَم|الأصل الإنجليزي/);
  });

  it('CSS стартовых поверхностей — только логические направления (иначе не зеркалится)', () => {
    const root = join(__dirname, '..', '..');
    const offenders: string[] = [];
    for (const rel of LAUNCH_SURFACE_CSS) {
      const css = readFileSync(join(root, rel), 'utf8')
        .split('\n')
        .filter((line) => !line.trim().startsWith('/*') && !line.trim().startsWith('*'))
        .join('\n');
      const hit = PHYSICAL_DIRECTION.exec(css);
      if (hit) offenders.push(`${rel}: ${hit[0].trim()}`);
    }
    expect(offenders).toEqual([]);
  });
});
