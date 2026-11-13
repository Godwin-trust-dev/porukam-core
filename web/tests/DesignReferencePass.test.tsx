import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { createI18n } from '@porukam/i18n';
import { DashboardPage } from '../src/pages/DashboardPage';
import { ContractsListPage } from '../src/pages/ContractsListPage';
import { OwnerProfilePage } from '../src/pages/OwnerProfilePage';
import { useAuthStore } from '../src/features/auth/authStore';
import { useActorStore } from '../src/features/actor/actorStore';

/**
 * Финал доска A (marketing/reference/front-upgrade/ref15_finalA_1.png),
 * замечание владельца 03.09: «Создать» на Главной и Сделках — FAB, не кнопка
 * в ленте; под шапкой профиля нет баннера; списки — строки без рамки-коробки.
 * Тесты держат ровно эти три факта, чтобы они не вернулись «по привычке».
 */
function renderAt(path: string, element: JSX.Element) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const i18n = createI18n('ru');
  return render(
    <QueryClientProvider client={qc}>
      <I18nextProvider i18n={i18n}>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path={path} element={element} />
            <Route path="*" element={<div data-testid="navigated" />} />
          </Routes>
        </MemoryRouter>
      </I18nextProvider>
    </QueryClientProvider>,
  );
}

describe('Финал доска A — FAB и профиль без баннера', () => {
  beforeEach(() => {
    useAuthStore.getState().setTokens({ access: 'a', refresh: 'r' });
    useActorStore.getState().reset();
    useActorStore.getState().setProfiles([
      { id: 'pf-person-1', kind: 'person', display_name: 'Годвин', handle: '@godwin', verification_level: 'basic', has_business_status: false },
    ]);
  });

  it('Главная: «Создать» — только FAB, кнопки «Создать договор» в шапке раздела нет', async () => {
    renderAt('/', <DashboardPage />);
    const list = await screen.findByTestId('dashboard-contracts');
    expect(list).toBeInTheDocument();
    expect(screen.getByTestId('dashboard-create-fab')).toHaveAttribute('aria-label', 'Создать договор');
    expect(screen.queryByTestId('dashboard-create')).not.toBeInTheDocument();
    // Строки — на одной поверхности (Surface), не карточка на каждую сделку.
    expect(within(list).getAllByTestId('contract-list-row').length).toBeGreaterThan(0);
  });

  it('Сделки: FAB «Создать» есть; роль во второй строке — «вы заказчик» строчными', async () => {
    renderAt('/contracts', <ContractsListPage />);
    const list = await screen.findByTestId('contracts-list');
    expect(screen.getByTestId('create-contract-fab')).toBeInTheDocument();
    const texts = within(list).getAllByTestId('contract-list-row').map((r) => r.textContent ?? '');
    expect(texts.some((t) => t.includes('вы заказчик') || t.includes('вы исполнитель'))).toBe(true);
    expect(texts.some((t) => t.includes('Вы — заказчик'))).toBe(false);
  });

  it('Профиль: под шапкой нет баннера «важное уведомление», есть ряд действий, плитки и меню', async () => {
    renderAt('/me', <OwnerProfilePage />);
    await screen.findByText('Годвин');
    expect(screen.queryByText('Срок приёмки этапа истекает через 2 часа')).not.toBeInTheDocument();
    expect(screen.queryByText('Авторизуйтесь через Госуслуги')).not.toBeInTheDocument();
    const actions = screen.getByTestId('me-actions');
    expect(within(actions).getByRole('button', { name: 'Редактировать' })).toBeInTheDocument();
    expect(within(actions).getByRole('button', { name: 'Как гость' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Уведомл\./ })).toBeInTheDocument();
    const menu = screen.getByTestId('me-menu');
    expect(within(menu).getByText('Мои сделки')).toBeInTheDocument();
    expect(within(menu).getByText('Настройки')).toBeInTheDocument();
    // Карточки «Репутация на фактах» между плитками и меню больше нет.
    expect(screen.queryByText('Репутация на фактах')).not.toBeInTheDocument();
  });

  /**
   * Финал доска A (`ref15_finalA_1.png`, экран «Профиль»): в меню РОВНО три
   * строки. Отдельного пункта «Вопросы и ответы» на доске нет — FAQ живёт
   * внутри «Что такое По рукам», маршрут `/help/faq` остаётся рабочим.
   */
  it('Профиль: меню — ровно три строки, FAQ отдельным пунктом не стоит', async () => {
    renderAt('/me', <OwnerProfilePage />);
    await screen.findByText('Годвин');
    const menu = screen.getByTestId('me-menu');
    expect(within(menu).getAllByRole('button')).toHaveLength(3);
    expect(within(menu).queryByText('Вопросы и ответы')).not.toBeInTheDocument();
    expect(within(menu).getByTestId('link-about')).toBeInTheDocument();
    expect(within(menu).getByTestId('link-settings')).toBeInTheDocument();
  });
});
