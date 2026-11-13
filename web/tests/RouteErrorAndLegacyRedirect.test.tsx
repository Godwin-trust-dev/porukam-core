import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { createI18n } from '@porukam/i18n';

import { ContractPage } from '../src/pages/ContractPage';
import { ShellErrorBoundary } from '../src/pages/RouteErrorPage';

/**
 * Отсмотр 2026-08-21: «Cannot read properties of undefined (reading 'some')»
 * на /contracts/:id/stages и соседях. Два рубежа:
 * 1) старые мок-вкладки договора в реальном контуре уводят в ContractDetailPage;
 * 2) любой необработанный крэш экрана — штатная страница ошибки, не белый экран.
 */

function Probe(): JSX.Element {
  const { pathname } = useLocation();
  return <span data-testid="url">{pathname}</span>;
}

function Boom(): JSX.Element {
  const broken = undefined as unknown as { milestones: unknown[] };
  return <>{broken.milestones.some(() => true)}</>;
}

function renderRoutes(path: string): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const i18n = createI18n('ru');
  render(
    <QueryClientProvider client={qc}>
      <I18nextProvider i18n={i18n}>
        <MemoryRouter initialEntries={[path]}>
          <Probe />
          <Routes>
            <Route element={<ShellErrorBoundary />}>
              <Route path="/contracts" element={<div data-testid="list-stub">list</div>} />
              {/* Как в src/app/router.tsx: index — карточка, вкладки — под ContractPage. */}
              <Route path="/contracts/:id">
                <Route index element={<div data-testid="detail-stub">detail</div>} />
                <Route element={<ContractPage />}>
                  <Route path="stages" element={<div data-testid="legacy-stages">legacy</div>} />
                </Route>
              </Route>
              <Route path="/boom" element={<Boom />} />
            </Route>
          </Routes>
        </MemoryRouter>
      </I18nextProvider>
    </QueryClientProvider>,
  );
}

describe('Старые вкладки договора в реальном контуре', () => {
  it('rc-* (реальный контур) /contracts/:id/stages → редирект в карточку, без крэша', async () => {
    renderRoutes('/contracts/rc-review-1/stages');
    expect(await screen.findByTestId('detail-stub')).toBeInTheDocument();
    expect(screen.getByTestId('url')).toHaveTextContent('/contracts/rc-review-1');
    expect(screen.queryByTestId('legacy-stages')).not.toBeInTheDocument();
  });
});

describe('ShellErrorBoundary — единый рубеж ошибок оболочки', () => {
  const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
  afterEach(() => spy.mockClear());

  it('крэш экрана → страница ошибки с «Повторить» и выходом к договорам', async () => {
    renderRoutes('/boom');
    expect(await screen.findByTestId('route-error-page')).toBeInTheDocument();
    expect(screen.getByText('Что-то пошло не так')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Повторить' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'К договорам' })).toBeInTheDocument();
  });

  it('«К договорам» уводит из сломанного экрана, граница сбрасывается', async () => {
    const { default: userEvent } = await import('@testing-library/user-event');
    renderRoutes('/boom');
    await userEvent.click(await screen.findByRole('button', { name: 'К договорам' }));
    expect(await screen.findByTestId('list-stub')).toBeInTheDocument();
    expect(screen.queryByTestId('route-error-page')).not.toBeInTheDocument();
  });
});
