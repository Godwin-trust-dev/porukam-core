import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { createI18n } from '@porukam/i18n';
import { ShellLayout } from '../src/pages/ShellLayout';

/** Сайдбар десктопа (отсмотр 12.09): «Поиск» должен быть В МЕНЮ СЛЕВА, а
 * «Что такое Porukam» — самым нижним пунктом. До этого поиск жил только в
 * мобильном bottom-nav, и на десктопе до каталога исполнителей было не
 * добраться. */
function renderShell(): HTMLElement {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const i18n = createI18n('ru');
  render(
    <QueryClientProvider client={qc}>
      <I18nextProvider i18n={i18n}>
        <MemoryRouter initialEntries={['/']}>
          <Routes>
            <Route path="/" element={<ShellLayout />}>
              <Route index element={<div>главная</div>} />
            </Route>
          </Routes>
        </MemoryRouter>
      </I18nextProvider>
    </QueryClientProvider>,
  );
  return screen.getAllByRole('navigation')[0] as HTMLElement;
}

describe('Сайдбар десктопа', () => {
  it('содержит «Поиск» со ссылкой на /search', () => {
    const nav = renderShell();
    const link = within(nav).getByRole('link', { name: /Поиск/ });
    expect(link).toHaveAttribute('href', '/search');
  });

  it('«Что такое Porukam» — последний пункт панели', () => {
    const nav = renderShell();
    const links = within(nav).getAllByRole('link');
    const last = links.at(-1);
    expect(last).toBeDefined();
    expect(last).toHaveAttribute('href', '/help/about');
    expect(last?.textContent).toContain('Porukam');
  });
});
