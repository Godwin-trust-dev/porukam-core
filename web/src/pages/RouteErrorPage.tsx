import { Component, type ErrorInfo, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { Button, ErrorState } from '@porukam/ui';

/**
 * Единый рубеж ошибок оболочки (отсмотр 2026-08-21): любое необработанное
 * исключение при рендере экрана — вместо белого «Unexpected Application
 * Error!» React Router — обычный ErrorState с «Повторить» и выходом к
 * договорам. Подключается как pathless-layout под ShellLayout, поэтому
 * рисуется ВНУТРИ оболочки (навигация остаётся доступной).
 *
 * Обычный React ErrorBoundary, а не `errorElement` роутера: граница
 * сбрасывается сменой маршрута (key=pathname) и одинаково тестируется с
 * MemoryRouter (data-router в jsdom навигировать не умеет).
 */
export function RouteErrorPage(): JSX.Element {
  const { t } = useTranslation();
  const navigate = useNavigate();
  return (
    <div data-testid="route-error-page" style={{ display: 'grid', gap: 'var(--pr-space-4, 16px)' }}>
      <ErrorState title={t('common.unexpectedErrorTitle')} retryLabel={t('common.retry')} onRetry={() => window.location.reload()} />
      <p style={{ textAlign: 'center', margin: 0 }}>{t('common.unexpectedErrorText')}</p>
      <div style={{ display: 'flex', justifyContent: 'center' }}>
        <Button variant="secondary" onClick={() => navigate('/contracts')}>
          {t('common.toContracts')}
        </Button>
      </div>
    </div>
  );
}

interface BoundaryState {
  failed: boolean;
}

class Boundary extends Component<{ children: ReactNode }, BoundaryState> {
  override state: BoundaryState = { failed: false };

  static getDerivedStateFromError(): BoundaryState {
    return { failed: true };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // eslint-disable-next-line no-console
    console.error('[ShellErrorBoundary]', error, info.componentStack);
  }

  override render(): ReactNode {
    return this.state.failed ? <RouteErrorPage /> : this.props.children;
  }
}

/** Pathless-layout для router.tsx: `{ element: <ShellErrorBoundary />, children: [...] }`. */
export function ShellErrorBoundary(): JSX.Element {
  const { pathname } = useLocation();
  return (
    <Boundary key={pathname}>
      <Outlet />
    </Boundary>
  );
}
