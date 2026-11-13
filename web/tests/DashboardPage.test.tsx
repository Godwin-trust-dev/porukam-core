import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { createI18n } from '@porukam/i18n';
import { DashboardPage } from '../src/pages/DashboardPage';
import { useAuthStore } from '../src/features/auth/authStore';
import { useActorStore } from '../src/features/actor/actorStore';
import { server } from '../src/mocks/server';
import { setProfileAvatar } from '../src/mocks/profilesDb';

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const i18n = createI18n('ru');
  return render(
    <QueryClientProvider client={qc}>
      <I18nextProvider i18n={i18n}>
        <MemoryRouter initialEntries={['/']}>
          <Routes>
            <Route path="/" element={<DashboardPage />} />
            <Route path="/contracts" element={<div data-testid="list-stub">list</div>} />
            <Route path="/contracts/:id" element={<div data-testid="detail-stub">detail</div>} />
            <Route path="/contracts/:id/sign" element={<div data-testid="sign-stub">sign</div>} />
            <Route path="/contracts/:id/stages/:sid" element={<div data-testid="stage-stub">stage</div>} />
          </Routes>
        </MemoryRouter>
      </I18nextProvider>
    </QueryClientProvider>,
  );
}

/**
 * DEV-03, ADR-090 — минимальный дашборд запуска. `pf-person-1` — тот же
 * актёр, что `ContractsListPage.test.tsx` (`realContractsDb.ts`): 2 pending
 * signature-запроса (`sr-1`/`sr-3`, side=customer) + 1 in_progress лист
 * (`ms-3`, contractor) + 1 under_acceptance лист, где Годвин заказчик
 * (`ms-review-1`, ADR-088 Фаза 6) — четыре пункта «внимания», микс сторон.
 */
describe('DashboardPage (DEV-03, ADR-090 — минимальный дашборд)', () => {
  beforeEach(() => {
    useAuthStore.getState().setTokens({ access: 'a', refresh: 'r' });
    useActorStore.getState().reset();
    useActorStore.getState().setProfiles([
      { id: 'pf-person-1', kind: 'person', display_name: 'Годвин', handle: '@godwin', verification_level: 'basic', has_business_status: false },
    ]);
  });

  it('«Требует внимания» — четыре пункта, микс сторон (signature×2 + submission + acceptance)', async () => {
    renderPage();
    const attention = await screen.findByTestId('dashboard-attention');
    await waitFor(() => expect(within(attention).getAllByRole('button')).toHaveLength(4));
    expect(within(attention).getAllByText('Заказчик').length).toBeGreaterThan(0);
    expect(within(attention).getAllByText('Исполнитель').length).toBeGreaterThan(0);
  });

  it('карточка подписи ведёт на /contracts/{id}/sign', async () => {
    renderPage();
    const attention = await screen.findByTestId('dashboard-attention');
    const buttons = await waitFor(() => {
      const found = within(attention).getAllByRole('button', { name: 'Подписать' });
      expect(found.length).toBeGreaterThan(0);
      return found;
    });
    await userEvent.click(buttons[0]!);
    expect(await screen.findByTestId('sign-stub')).toBeInTheDocument();
  });

  it('карточки приёмки/сдачи ведут на реальную страницу этапа (дашбордная доводка)', async () => {
    renderPage();
    const attention = await screen.findByTestId('dashboard-attention');
    const buttons = await waitFor(() => {
      const found = within(attention).getAllByRole('button', { name: 'Открыть приёмку' });
      expect(found.length).toBeGreaterThan(0); // submission (ms-3) + acceptance (ms-review-1)
      return found;
    });
    await userEvent.click(buttons[0]!);
    expect(await screen.findByTestId('stage-stub')).toBeInTheDocument();
  });

  // DEV-20 §5 (заменяет грид плиток DEV-19 §3): превью сделок — те же СТРОКИ,
  // что на `/contracts`, на одной поверхности. Плитки (`contract-tile`) на
  // дашборде больше нет: полутора сделок на экран телефона мало, а язык списка
  // должен быть один на всех экранах.
  it('превью «мои сделки» показывает строки сделок', async () => {
    renderPage();
    const list = await screen.findByTestId('dashboard-contracts');
    await waitFor(() => expect(within(list).getAllByTestId('contract-list-row').length).toBeGreaterThan(0));
    expect(within(list).queryByTestId('contract-tile')).not.toBeInTheDocument();
  });

  /**
   * Замечание владельца 2026-09-08 (скриншот `Screenshot_20260906_105841_Chrome.jpg`):
   * «Активные договоры» на Главной — та же `RealContractRow`, что и в списке
   * сделок (ADR-090 §1), поэтому фото контрагента обязано появиться и здесь.
   * Тест держит именно это: общий компонент, а не вторая копия строки.
   */
  it('фото контрагента показывается и в превью «мои сделки» на Главной', async () => {
    const { avatar_url } = setProfileAvatar('pf-mock-contractor-1', new Uint8Array([1, 2, 3]), 'image/png');
    renderPage();
    const list = await screen.findByTestId('dashboard-contracts');
    await waitFor(() => expect(within(list).getAllByTestId('contract-list-row').length).toBeGreaterThan(0));
    await waitFor(() => expect(list.querySelector('img')).not.toBeNull());
    expect(list.querySelector('img')).toHaveAttribute('src', avatar_url!);
  });

  it('ошибка загрузки сделок — доменный код и повтор', async () => {
    server.use(
      http.get('/v1/contracts', () =>
        HttpResponse.json({ status: 500, code: 'internal_error', title: 'internal_error' }, { status: 500 }),
      ),
    );
    renderPage();
    expect(await screen.findByText('Не удалось загрузить рабочий стол.')).toBeInTheDocument();
    expect(screen.getByText('code: internal_error')).toBeInTheDocument();
  });

  it('пустой актёр без сделок/внимания — пустое состояние', async () => {
    const emptyActor = { id: 'pf-empty-actor', kind: 'person', display_name: 'Новый', handle: '@new', verification_level: 'basic', has_business_status: false } as const;
    // /users/me — источник истины для актёр-стора (useCurrentUser → setProfiles):
    // id, которого нет в ответе, сбрасывается на первый профиль, поэтому мок
    // должен отдавать того же пустого актёра.
    server.use(http.get('/v1/users/me', () => HttpResponse.json({ id: 'u-empty', profiles: [emptyActor] })));
    useActorStore.getState().reset();
    useActorStore.getState().setProfiles([emptyActor]);
    renderPage();
    expect(await screen.findByText('Пока нет активных сделок')).toBeInTheDocument();
    expect(screen.queryByTestId('dashboard-attention')).not.toBeInTheDocument();
  });
});
