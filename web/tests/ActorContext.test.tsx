import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { http, HttpResponse } from 'msw';
import { createI18n } from '@porukam/i18n';
import type { ActorProfile } from '@porukam/core';
import { server } from '../src/mocks/server';
import { resetGroups } from '../src/mocks/groupsHandlers';
import { useAuthStore } from '../src/features/auth/authStore';
import { actorKeyOf, useActorStore } from '../src/features/actor/actorStore';
import { ActorSwitcher } from '../src/features/actor/ActorSwitcher';
import { useRealContractsList } from '../src/features/contracts/realApi';
import { GroupDetailPage } from '../src/pages/GroupDetailPage';
import { GroupSettingsPage } from '../src/pages/settings/GroupSettingsPage';
import { SettingsLayout } from '../src/pages/settings/SettingsLayout';

/**
 * Контекст актёра (ADR-129): объединение — такой же актёр оболочки, как личный
 * профиль и организация. Проверяем три вещи, которые ломались бы молча:
 * смена актёра перезапрашивает данные, из карточки объединения ушли настройки
 * (осталось «Пригласить»), логотип и хендл правятся в разделе настроек.
 *
 * `pf-person-1` — лидер `grp-3` в моке (`groupsHandlers`), поэтому объединение
 * попадает в переключатель у демо-пользователя.
 */

const PROFILES: ActorProfile[] = [
  { id: 'pf-person-1', kind: 'person', display_name: 'Годвин', handle: '@godwin', verification_level: 'basic', has_business_status: false },
  { id: 'pf-biz-1', kind: 'business', display_name: 'СтройБыт', handle: '@stroybyt', verification_level: 'verified', has_business_status: true, legal_form: 'ooo' },
];

beforeEach(() => {
  useAuthStore.getState().setTokens({ access: 'a', refresh: 'r' });
  useActorStore.getState().reset();
  useActorStore.getState().setProfiles(PROFILES);
  resetGroups();
});

function renderAt(path: string, ui: JSX.Element): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <I18nextProvider i18n={createI18n('ru')}>
        <MemoryRouter initialEntries={[path]}>{ui}</MemoryRouter>
      </I18nextProvider>
    </QueryClientProvider>,
  );
}

describe('actorKey — единая величина контекста (ADR-129 §3)', () => {
  it('объединение перебивает профиль, снятие объединения возвращает профиль', () => {
    expect(actorKeyOf('pf-person-1', null)).toBe('pf-person-1');
    expect(actorKeyOf('pf-person-1', 'grp-3')).toBe('group:grp-3');
  });

  it('выбор объединения переводит X-Acting-Profile на person-профиль, выбор профиля снимает объединение', () => {
    const store = useActorStore.getState();
    store.setActive('pf-biz-1');
    store.setActiveGroup('grp-3');
    expect(useActorStore.getState().activeGroupId).toBe('grp-3');
    // Объединение не сторона договора (tech-spec §5.2.1b) — доменные запросы
    // идут от физлица, а не от прежней организации.
    expect(useActorStore.getState().activeProfileId).toBe('pf-person-1');

    useActorStore.getState().setActive('pf-biz-1');
    expect(useActorStore.getState().activeGroupId).toBeNull();
  });

  it('объединение, которым больше не управляют, перестаёт быть активным актёром', () => {
    const store = useActorStore.getState();
    store.setGroups([{ id: 'grp-3', name: 'Артель', handle: '@mebel_artel', logoUrl: null }]);
    store.setActiveGroup('grp-3');
    useActorStore.getState().setGroups([]);
    expect(useActorStore.getState().activeGroupId).toBeNull();
  });
});

/** Зонд списка сделок: считает запросы и показывает, под каким актёром они ушли. */
function ContractsProbe(): JSX.Element {
  const q = useRealContractsList({});
  return <div data-testid="probe">{q.isFetching ? 'fetching' : `rows:${q.data?.length ?? 0}`}</div>;
}

describe('смена актёра перезапрашивает данные', () => {
  it('выбор объединения в шапке — новый запрос списка сделок, в триггере имя объединения', async () => {
    const actors: (string | null)[] = [];
    server.use(
      http.get('/v1/contracts', ({ request }) => {
        actors.push(request.headers.get('X-Acting-Profile'));
        return HttpResponse.json([]);
      }),
    );

    renderAt(
      '/contracts',
      <>
        <ActorSwitcher />
        <ContractsProbe />
      </>,
    );

    await waitFor(() => expect(actors.length).toBe(1));
    await screen.findByTestId('actor-trigger');

    await userEvent.click(screen.getByTestId('actor-trigger'));
    // Объединение — полноценная строка актёра, а не ярлык перехода в карточку.
    const row = await screen.findByTestId('actor-group-grp-3');
    await userEvent.click(row);

    // Данные прежнего актёра не остаются в кэше: ключ включает actorKey.
    await waitFor(() => expect(actors.length).toBe(2));
    expect(useActorStore.getState().activeGroupId).toBe('grp-3');
    expect(screen.getByTestId('actor-active')).toHaveTextContent('Мебельная артель');
  });

  it('выбор организации меняет X-Acting-Profile в следующем запросе', async () => {
    const actors: (string | null)[] = [];
    server.use(
      http.get('/v1/contracts', ({ request }) => {
        actors.push(request.headers.get('X-Acting-Profile'));
        return HttpResponse.json([]);
      }),
    );

    renderAt(
      '/contracts',
      <>
        <ActorSwitcher />
        <ContractsProbe />
      </>,
    );
    await waitFor(() => expect(actors).toEqual(['pf-person-1']));

    await userEvent.click(screen.getByTestId('actor-trigger'));
    await userEvent.click(screen.getByTestId('actor-option-pf-biz-1'));

    await waitFor(() => expect(actors).toEqual(['pf-person-1', 'pf-biz-1']));
  });
});

describe('карточка объединения: из действий владельца осталось «Пригласить»', () => {
  it('лидер видит приглашение, но не логотип/хендл/витрину — они в настройках', async () => {
    useActorStore.setState({ activeProfileId: 'pf-person-1' });
    renderAt('/groups/grp-3', <Routes><Route path="/groups/:groupId" element={<GroupDetailPage />} /></Routes>);

    await screen.findByText('Мебельная артель');
    expect(await screen.findByTestId('group-invite-handle')).toBeInTheDocument();
    expect(screen.getByTestId('group-invite-submit')).toBeInTheDocument();

    expect(screen.queryByTestId('group-edit')).not.toBeInTheDocument();
    expect(screen.queryByTestId('group-logo-input')).not.toBeInTheDocument();
    expect(screen.queryByTestId('group-handle-input')).not.toBeInTheDocument();

    // Указатель, куда уехали настройки: ведёт в раздел активного актёра.
    const link = screen.getByTestId('group-open-settings');
    expect(link).toHaveAttribute('href', '/me/settings/group');
    await userEvent.click(link);
    expect(useActorStore.getState().activeGroupId).toBe('grp-3');
  });
});

describe('настройки объединения — раздел активного актёра', () => {
  it('в списке разделов «Объединение» появляется только когда объединение активно', async () => {
    renderAt(
      '/me/settings/profile',
      <Routes>
        <Route path="/me/settings" element={<SettingsLayout />}>
          <Route path="profile" element={<div data-testid="profile-section" />} />
          <Route path="group" element={<div data-testid="group-section" />} />
        </Route>
      </Routes>,
    );
    await screen.findByTestId('profile-section');
    // Полосы вкладок в настройках больше нет (замечание владельца 01.09):
    // разделы — рейл на десктопе и строки хаба на телефоне. Проверяем рейл —
    // он в разметке всегда, скрывает его только CSS-брейкпоинт.
    expect(screen.queryByTestId('settings-nav-group')).not.toBeInTheDocument();
  });

  it('с активным объединением раздел есть и открывается', async () => {
    useActorStore.getState().setGroups([{ id: 'grp-3', name: 'Мебельная артель', handle: '@mebel_artel', logoUrl: null }]);
    useActorStore.getState().setActiveGroup('grp-3');
    renderAt(
      '/me/settings/profile',
      <Routes>
        <Route path="/me/settings" element={<SettingsLayout />}>
          <Route path="profile" element={<div data-testid="profile-section" />} />
          <Route path="group" element={<div data-testid="group-section" />} />
        </Route>
      </Routes>,
    );
    const tab = await screen.findByTestId('settings-nav-group');
    expect(tab).toHaveTextContent('Объединение');
    await userEvent.click(tab);
    expect(await screen.findByTestId('group-section')).toBeInTheDocument();
  });

  it('логотип и хендл правятся в настройках, а не в карточке', async () => {
    useActorStore.getState().setGroups([{ id: 'grp-3', name: 'Мебельная артель', handle: '@mebel_artel', logoUrl: null }]);
    useActorStore.getState().setActiveGroup('grp-3');
    renderAt('/me/settings/group', <GroupSettingsPage />);

    const page = await screen.findByTestId('group-settings');
    expect(within(page).getByTestId('group-settings-handle')).toHaveTextContent('@mebel_artel');

    // Хендл
    await userEvent.type(screen.getByTestId('group-handle-input'), 'nasha_artel');
    await userEvent.click(screen.getByTestId('group-handle-save'));
    await waitFor(() => expect(screen.getByTestId('group-settings-handle')).toHaveTextContent('@nasha_artel'));

    // Логотип — тот же пайплайн, что аватар профиля (ADR-117 §8).
    const file = new File(['x'], 'logo.png', { type: 'image/png' });
    await userEvent.upload(screen.getByTestId('group-logo-input'), file);
    await waitFor(() => expect(screen.getByTestId('group-settings-logo')).toBeInTheDocument());
  });

  it('витрина правится в настройках: PATCH меняет название, сферу и город (ADR-117 §§2–3)', async () => {
    // Переехало сюда из карточки `/groups/{id}` (было в SearchGroupsPages.test.tsx).
    useActorStore.getState().setGroups([{ id: 'grp-3', name: 'Мебельная артель', handle: '@mebel_artel', logoUrl: null }]);
    useActorStore.getState().setActiveGroup('grp-3');
    renderAt('/me/settings/group', <GroupSettingsPage />);

    const form = await screen.findByTestId('group-form');
    await userEvent.clear(within(form).getByTestId('group-name'));
    await userEvent.type(within(form).getByTestId('group-name'), 'Артель мебельщиков');
    await userEvent.selectOptions(within(form).getByTestId('group-geo'), 'city');
    await userEvent.selectOptions(within(form).getByTestId('group-country'), 'KZ');
    await userEvent.clear(within(form).getByTestId('group-city'));
    await userEvent.type(within(form).getByTestId('group-city'), 'Астана');
    await userEvent.click(screen.getByTestId('group-edit-submit'));

    expect(await screen.findByText('Сохранено')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('group-settings')).toHaveTextContent('Артель мебельщиков'));
  });

  it('без активного объединения раздел объясняет, что выбрать актёра в шапке', async () => {
    renderAt('/me/settings/group', <GroupSettingsPage />);
    expect(await screen.findByText(/Выберите объединение в переключателе/)).toBeInTheDocument();
  });
});

describe('«Выйти» из шапки (замечание владельца 07.09)', () => {
  it('клик по пункту меню гасит сессию, чистит актёра и уводит на /welcome', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(['me'], { display_name: 'Годвин' });
    render(
      <QueryClientProvider client={qc}>
        <I18nextProvider i18n={createI18n('ru')}>
          <MemoryRouter initialEntries={['/contracts']}>
            <Routes>
              <Route path="/contracts" element={<ActorSwitcher />} />
              <Route path="/welcome" element={<div>экран приветствия</div>} />
            </Routes>
          </MemoryRouter>
        </I18nextProvider>
      </QueryClientProvider>,
    );

    await userEvent.click(await screen.findByTestId('actor-trigger'));
    await userEvent.click(screen.getByTestId('logout'));

    await screen.findByText('экран приветствия');
    expect(useAuthStore.getState().isAuthenticated).toBe(false);
    expect(useAuthStore.getState().refresh).toBeNull();
    expect(useActorStore.getState().profiles).toEqual([]);
    // Кэш чужого аккаунта не должен пережить выход.
    expect(qc.getQueryData(['me'])).toBeUndefined();
  });
});
