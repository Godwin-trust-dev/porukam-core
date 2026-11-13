import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { createI18n } from '@porukam/i18n';
import { LegalDocumentPage } from '../src/pages/LegalDocumentPage';

function renderPage(path: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const i18n = createI18n('ru');
  return {
    i18n,
    ...render(
      <QueryClientProvider client={qc}>
        <I18nextProvider i18n={i18n}>
          <MemoryRouter initialEntries={[path]}>
            <Routes>
              <Route path="/legal/:doc" element={<LegalDocumentPage />} />
            </Routes>
          </MemoryRouter>
        </I18nextProvider>
      </QueryClientProvider>,
    ),
  };
}

/**
 * Публичные страницы юр-документов: Google Play и App Store требуют ссылку,
 * которая открывается у постороннего человека в браузере без входа —
 * шторкой внутри SPA это требование не закрыть.
 */
describe('LegalDocumentPage (публичные /legal/*)', () => {
  it('⭐ гость (без токена) видит документ: запрос идёт и текст показывается', async () => {
    renderPage('/legal/terms');
    expect(await screen.findByRole('heading', { name: 'Условия использования' })).toBeInTheDocument();
    // Тело документа отрисовано, а не только заголовок страницы.
    await screen.findByRole('article');
  });

  it('⭐ `?lang=en` — документ и заголовок по-английски, как их увидит проверяющий Google', async () => {
    const { i18n } = renderPage('/legal/privacy?lang=en');
    expect(await screen.findByRole('heading', { name: 'Privacy Policy' })).toBeInTheDocument();
    expect(i18n.language).toBe('en');
  });

  it('неизвестный документ — честная ошибка, а не пустая страница', async () => {
    renderPage('/legal/unknown-doc');
    expect(await screen.findByText('code: not_found')).toBeInTheDocument();
  });
});
