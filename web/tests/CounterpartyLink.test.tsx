import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { createI18n, loadLocaleResources } from '@porukam/i18n';
import { CounterpartyLink, counterpartyHref } from '../src/features/counterparty/CounterpartyLink';
import { StagesPage } from '../src/pages/StagesPage';
import { NotificationDetailPane } from '../src/features/notifications/NotificationDetailPane';
import { useAuthStore } from '../src/features/auth/authStore';
import { useActorStore } from '../src/features/actor/actorStore';

/**
 * Бэклог 2026-08-21: «контрагент → профиль кликабелен везде + копирование
 * хендла». Компонент общий (`CounterpartyLink`), поэтому проверяем его самого
 * и два места использования — раздел /stages и панель уведомления.
 *
 * Сиды моков: `pf-mock-contractor-1` — имя из `GET /profiles/{id}`
 * («Анна Кузнецова», profilesDb), хендл — из карточки репутации
 * (`marat_otdelkin`, reputationHandlers).
 */

const writeText = vi.fn(async () => undefined);

async function renderWith(node: JSX.Element, path = '/') {
  const i18n = createI18n('ru');
  await loadLocaleResources(i18n, 'ru');
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <I18nextProvider i18n={i18n}>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path={path} element={node} />
            <Route path="/:handle" element={<div data-testid="public-card" />} />
            <Route path="/reputation/profiles/:profileId" element={<div data-testid="reputation-card" />} />
            <Route path="/contracts/:id" element={<div data-testid="contract-page" />} />
          </Routes>
        </MemoryRouter>
      </I18nextProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  writeText.mockClear();
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
  useAuthStore.getState().setTokens({ access: 'a', refresh: 'r' });
  useActorStore.setState({ activeProfileId: 'pf-person-1' });
});

describe('counterpartyHref — публичный адрес стороны', () => {
  it('хендл (с «@» и без) → гостевая ссылка /@handle', () => {
    expect(counterpartyHref('pf-1', 'masha')).toBe('/@masha');
    expect(counterpartyHref('pf-1', '@masha')).toBe('/@masha');
  });

  it('без хендла → карточка по profile_id; без обоих — ссылки нет', () => {
    expect(counterpartyHref('pf-1', null)).toBe('/reputation/profiles/pf-1');
    expect(counterpartyHref(null, null)).toBeNull();
  });
});

describe('CounterpartyLink', () => {
  it('резолвит имя и хендл, ведёт на /@хендл, копирует «@хендл» с тостом', async () => {
    await renderWith(<CounterpartyLink profileId="pf-mock-contractor-1" showAvatar />);

    const link = await screen.findByTestId('counterparty-link');
    // Имя — из `profilesDb` (единый реестр мока): контрагент сидов ещё
    // 25.08 стал «Марат Отделкин», а этот тест остался на прежнем имени и
    // с тех пор был красным.
    await waitFor(() => expect(link).toHaveTextContent('Марат Отделкин'));
    await waitFor(() => expect(link).toHaveAttribute('href', '/@marat_otdelkin'));
    expect(screen.getByTestId('counterparty-link-handle')).toHaveTextContent('@marat_otdelkin');

    await userEvent.click(screen.getByTestId('counterparty-link-copy'));
    expect(writeText).toHaveBeenCalledWith('@marat_otdelkin');
    expect(await screen.findByText('Скопировано')).toBeInTheDocument();
  });

  it('переходит по ссылке на публичную карточку', async () => {
    await renderWith(<CounterpartyLink profileId="pf-mock-contractor-1" />);
    const link = await screen.findByTestId('counterparty-link');
    await waitFor(() => expect(link).toHaveAttribute('href', '/@marat_otdelkin'));
    await userEvent.click(link);
    expect(await screen.findByTestId('public-card')).toBeInTheDocument();
  });

  it('showHandle=false: ссылка по profile_id, хендла и копирования нет', async () => {
    await renderWith(<CounterpartyLink profileId="pf-mock-contractor-1" name="Марат" showHandle={false} />);
    const link = screen.getByTestId('counterparty-link');
    expect(link).toHaveAttribute('href', '/reputation/profiles/pf-mock-contractor-1');
    expect(link).toHaveTextContent('Марат');
    expect(screen.queryByTestId('counterparty-link-copy')).not.toBeInTheDocument();
  });

  it('без profile_id и хендла — просто текст, не ссылка', async () => {
    await renderWith(<CounterpartyLink name="Скрытый профиль" />);
    const node = screen.getByTestId('counterparty-link');
    expect(node.tagName).toBe('SPAN');
    expect(node).toHaveTextContent('Скрытый профиль');
  });
});

describe('Контрагент кликабелен в местах использования', () => {
  it('/stages: имя контрагента ведёт на его карточку, а не в договор', async () => {
    await renderWith(<StagesPage />, '/stages');
    const list = await screen.findByTestId('stages-list');
    const link = within(list).getAllByTestId('counterparty-link')[0]!;
    expect(link).toHaveTextContent('Марат Отделкин');
    expect(link).toHaveAttribute('href', '/reputation/profiles/pf-mock-contractor-1');
    await userEvent.click(link);
    expect(await screen.findByTestId('reputation-card')).toBeInTheDocument();
    expect(screen.queryByTestId('contract-page')).not.toBeInTheDocument();
  });

  it('панель уведомления: контрагент — ссылка + копирование хендла', async () => {
    await renderWith(
      <NotificationDetailPane
        notification={{
          id: 'n-1',
          type: 'signature',
          title: 'Договор подписан',
          severity: 'normal',
          created_at: '2026-08-21T10:00:00Z',
          read: true,
          group: 'today',
          counterparty: { name: 'Марат Отделкин', profile_id: 'pf-mock-contractor-1' },
        }}
        icon="bell"
        onOpen={vi.fn()}
      />,
    );
    const link = await screen.findByTestId('notification-counterparty');
    expect(link).toHaveTextContent('Марат Отделкин');
    await waitFor(() => expect(link).toHaveAttribute('href', '/@marat_otdelkin'));
    await userEvent.click(screen.getByTestId('notification-counterparty-copy'));
    expect(writeText).toHaveBeenCalledWith('@marat_otdelkin');
  });
});
