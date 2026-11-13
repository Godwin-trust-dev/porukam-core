import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { createI18n } from '@porukam/i18n';
import { ContractsListPage } from '../src/pages/ContractsListPage';
import { NotificationsPage } from '../src/pages/NotificationsPage';
import { DashboardPage } from '../src/pages/DashboardPage';
import { useAuthStore } from '../src/features/auth/authStore';
import { useActorStore } from '../src/features/actor/actorStore';
import {
  WIDTH_DESKTOP,
  WIDTH_MOBILE_MAX,
  WIDTH_PHONE,
  WIDTH_WIDE,
  setViewportWidth,
} from './viewport';

/** Печатает текущий URL — чтобы проверять, что выбор действительно живёт в нём. */
function LocationProbe(): JSX.Element {
  const { pathname, search } = useLocation();
  return <span data-testid="url">{`${pathname}${search}`}</span>;
}

function renderApp(path: string): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const i18n = createI18n('ru');
  render(
    <QueryClientProvider client={qc}>
      <I18nextProvider i18n={i18n}>
        <MemoryRouter initialEntries={[path]}>
          <LocationProbe />
          <Routes>
            <Route path="/" element={<DashboardPage />} />
            <Route path="/contracts" element={<ContractsListPage />} />
            <Route path="/notifications" element={<NotificationsPage />} />
            <Route path="/contracts/new/*" element={<div data-testid="wizard-stub">wizard</div>} />
            <Route path="/contracts/:id" element={<div data-testid="detail-stub">detail</div>} />
            <Route path="/contracts/:id/stages/:sid" element={<div data-testid="stage-stub">stage</div>} />
          </Routes>
        </MemoryRouter>
      </I18nextProvider>
    </QueryClientProvider>,
  );
}

/**
 * DEV-19 (ADR-099) — десктоп-адаптив: ОДИН экран с брейкпоинтом, а не второй
 * набор экранов. Тесты проверяют ровно то, что обещано в §8:
 * `<1024` — мобильная стопка и обычная навигация, `≥1024` — master-detail с
 * выбором в URL (deep-link и F5 его не теряют).
 *
 * jsdom не реализует `matchMedia`, поэтому ширину ставим явно (./viewport.ts);
 * остальной набор тестов идёт по мобильной ветке — так и задумано.
 */
describe('DEV-19 — десктоп-адаптив', () => {
  let restore: () => void = () => {};

  beforeEach(() => {
    useAuthStore.getState().setTokens({ access: 'a', refresh: 'r' });
    useActorStore.getState().reset();
    useActorStore.getState().setProfiles([
      { id: 'pf-person-1', kind: 'person', display_name: 'Годвин', handle: '@godwin', verification_level: 'basic', has_business_status: false },
    ]);
  });

  afterEach(() => restore());

  describe('«Мои договоры» — master-detail (§2)', () => {
    it('⭐ ≥1024: клик по строке ВЫДЕЛЯЕТ её и открывает детали, не уходя со списка', async () => {
      restore = setViewportWidth(WIDTH_DESKTOP);
      renderApp('/contracts');

      const list = await screen.findByTestId('contracts-list');
      await waitFor(() => expect(within(list).getAllByTestId('contract-list-row').length).toBeGreaterThan(0));
      const row = within(list).getAllByTestId('contract-list-row')[0]!;
      await userEvent.click(row);

      // Выбор — в URL (?sel=), а не во внутреннем состоянии.
      await waitFor(() => expect(screen.getByTestId('url').textContent).toMatch(/^\/contracts\?.*sel=/));
      // Список НА МЕСТЕ, страница деталей НЕ открывалась.
      expect(screen.getByTestId('contracts-list')).toBeInTheDocument();
      expect(screen.queryByTestId('detail-stub')).not.toBeInTheDocument();
      // Детали — в той же странице, строка помечена выбранной.
      expect(await screen.findByTestId('contract-detail-pane')).toBeInTheDocument();
      expect(row).toHaveAttribute('aria-current', 'true');
    });

    it('⭐ deep-link ?sel= (он же F5): выбор восстановлен без единого клика', async () => {
      restore = setViewportWidth(WIDTH_WIDE);
      renderApp('/contracts?sel=rc-review-1');

      const pane = await screen.findByTestId('contract-detail-pane');
      expect(pane).toHaveAttribute('data-contract-id', 'rc-review-1');
      expect(await within(pane).findByText('Сборка мебели — гостиная')).toBeInTheDocument();
    });

    it('⭐ <1024: колонки деталей НЕТ, тап по строке — обычный переход на карточку', async () => {
      restore = setViewportWidth(WIDTH_MOBILE_MAX);
      renderApp('/contracts');

      expect(screen.queryByTestId('master-detail-pane')).not.toBeInTheDocument();

      const list = await screen.findByTestId('contracts-list');
      await waitFor(() => expect(within(list).getAllByTestId('contract-list-row').length).toBeGreaterThan(0));
      await userEvent.click(within(list).getAllByTestId('contract-list-row')[0]!);

      expect(await screen.findByTestId('detail-stub')).toBeInTheDocument();
    });

    it('≥1024 без выбора: колонка деталей объясняет, что делать, а не пустует', async () => {
      restore = setViewportWidth(WIDTH_DESKTOP);
      renderApp('/contracts');

      const pane = await screen.findByTestId('master-detail-pane');
      expect(within(pane).getByText('Выберите договор')).toBeInTheDocument();
    });

    it('из деталей есть выход на полную карточку (§4)', async () => {
      restore = setViewportWidth(WIDTH_DESKTOP);
      renderApp('/contracts?sel=rc-review-1');

      await userEvent.click(await screen.findByTestId('pane-full-card'));
      expect(await screen.findByTestId('detail-stub')).toBeInTheDocument();
    });
  });

  describe('Уведомления — master-detail (§2)', () => {
    it('⭐ ≥1024: пункт раскрывается справа, выбор — в URL', async () => {
      restore = setViewportWidth(WIDTH_DESKTOP);
      renderApp('/notifications');

      const items = await screen.findAllByTestId('notification-item');
      await userEvent.click(items[0]!);

      await waitFor(() => expect(screen.getByTestId('url').textContent).toMatch(/^\/notifications\?.*sel=/));
      expect(await screen.findByTestId('notification-detail-pane')).toBeInTheDocument();
      expect(screen.queryByTestId('detail-stub')).not.toBeInTheDocument();
    });

    it('⭐ <1024: тап уводит к месту события, как и раньше', async () => {
      restore = setViewportWidth(WIDTH_PHONE);
      renderApp('/notifications');

      const items = await screen.findAllByTestId('notification-item');
      await userEvent.click(items[0]!);

      await waitFor(() => expect(screen.getByTestId('url').textContent).not.toBe('/notifications'));
      expect(screen.queryByTestId('notification-detail-pane')).not.toBeInTheDocument();
    });
  });

  describe('Дашборд — мультиколонка + правый рейл (§3)', () => {
    it('⭐ правый рейл есть на обеих ширинах — на узкой он просто уходит вниз', async () => {
      restore = setViewportWidth(WIDTH_DESKTOP);
      renderApp('/');
      expect(await screen.findByTestId('dashboard-rail')).toBeInTheDocument();
      restore();

      restore = setViewportWidth(WIDTH_PHONE);
      renderApp('/');
      expect(await screen.findByTestId('dashboard-rail')).toBeInTheDocument();
    });

    // DEV-20 §5 отменяет грид плиток (DEV-19 §3): на широкой ширине дашборд
    // показывает те же плотные СТРОКИ, что список сделок, — один язык списка
    // на всех ширинах, ширину добирает правый рейл.
    it('сделки — плотные строки, плиток больше нет', async () => {
      restore = setViewportWidth(WIDTH_WIDE);
      renderApp('/');
      const list = await screen.findByTestId('dashboard-contracts');
      await waitFor(() => expect(within(list).getAllByTestId('contract-list-row').length).toBeGreaterThan(0));
      expect(within(list).queryByTestId('contract-tile')).not.toBeInTheDocument();
    });
  });
});
