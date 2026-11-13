import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { createI18n } from '@porukam/i18n';
import { LegalDocumentPage, LegalTosRedirect } from '../src/pages/LegalDocumentPage';
import { explicitLegalLang } from '../src/features/locale/useLocaleResolution';

function Where(): JSX.Element {
  const l = useLocation();
  return <p data-testid="where">{l.pathname + l.search}</p>;
}

function renderAt(path: string, lang: string) {
  const i18n = createI18n(lang);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <I18nextProvider i18n={i18n}>
        <MemoryRouter initialEntries={[path]}>
          <Where />
          <Routes>
            <Route path="/legal/tos" element={<LegalTosRedirect />} />
            <Route path="/legal/:doc" element={<LegalDocumentPage />} />
          </Routes>
        </MemoryRouter>
      </I18nextProvider>
    </QueryClientProvider>,
  );
  return i18n;
}

describe('?lang= на /legal/*', () => {
  it('explicitLegalLang: только на /legal/*, мусор игнорируется', () => {
    expect(explicitLegalLang('/legal/privacy', '?lang=en')).toBe('en');
    expect(explicitLegalLang('/legal/account-deletion', '?lang=en')).toBe('en');
    expect(explicitLegalLang('/legal/privacy', '?lang=zz')).toBeNull();
    expect(explicitLegalLang('/legal/privacy', '')).toBeNull();
    expect(explicitLegalLang('/contracts', '?lang=en')).toBeNull();
  });

  it('?lang=en перебивает активный русский язык; без ?lang= остаётся русский', async () => {
    const en = renderAt('/legal/privacy?lang=en', 'ru');
    expect(await screen.findByRole('heading', { name: 'Privacy Policy' })).toBeInTheDocument();
    expect(en.language).toBe('en');
  });

  it('без ?lang= остаётся язык интерфейса', async () => {
    const ru = renderAt('/legal/privacy', 'ru');
    expect(await screen.findByRole('heading', { name: 'Политика конфиденциальности' })).toBeInTheDocument();
    expect(ru.language).toBe('ru');
  });

  it('/legal/tos ведёт на условия с сохранением ?lang=', async () => {
    renderAt('/legal/tos?lang=en', 'ru');
    expect(await screen.findByRole('heading', { name: 'Terms of Service' })).toBeInTheDocument();
    expect(screen.getByTestId('where').textContent).toBe('/legal/terms?lang=en');
  });
});
