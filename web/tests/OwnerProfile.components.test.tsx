import { useState } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nextProvider } from 'react-i18next';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { createI18n } from '@porukam/i18n';
import { NextStepSlot, SettingRow, Toggle, VerificationLevel } from '@porukam/ui';
import { ProfileSettingsPage } from '../src/pages/settings/ProfileSettingsPage';
import { useAuthStore } from '../src/features/auth/authStore';
import { useActorStore } from '../src/features/actor/actorStore';
import { server } from '../src/mocks/server';

describe('VerificationLevel (DEV-02)', () => {
  it('рендерит 3 сегмента и подпись «Верификация N / 3»', () => {
    const { container } = render(<VerificationLevel level={2} label="Верификация 2 / 3" />);
    expect(screen.getByLabelText('Верификация 2 / 3')).toBeInTheDocument();
    const segments = container.querySelectorAll('[aria-hidden="true"] > span');
    expect(segments).toHaveLength(3);
  });
});

describe('NextStepSlot (DEV-02) — три ветки', () => {
  it('без variant/title — не рендерится вовсе', () => {
    const { container } = render(<NextStepSlot />);
    expect(container).toBeEmptyDOMElement();
  });

  it('variant=action — рендерит кнопку и вызывает onClick', async () => {
    const onClick = vi.fn();
    render(<NextStepSlot variant="action" title="Авторизуйтесь через Госуслуги" subtitle="Уровень 3" onClick={onClick} />);
    await userEvent.click(screen.getByRole('button', { name: /Авторизуйтесь через Госуслуги/ }));
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('variant=notice с onClick — вся полоса кнопка, подпись-действие кликабельна (мобильный проход 25.08)', async () => {
    const onClick = vi.fn();
    render(<NextStepSlot variant="notice" title="Срок приёмки этапа истекает через 2 часа" subtitle="Принять этап" onClick={onClick} />);
    await userEvent.click(screen.getByText('Принять этап'));
    expect(onClick).toHaveBeenCalledOnce();
    expect(screen.getByRole('button', { name: /Принять этап/ })).toBeInTheDocument();
  });

  it('variant=notice без onClick — рендерит статичный блок', () => {
    render(<NextStepSlot variant="notice" title="Договор ждёт подписи" subtitle="Осталось подписать" />);
    expect(screen.getByText('Договор ждёт подписи')).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});

function ToggleHarness(): JSX.Element {
  const [checked, setChecked] = useState(false);
  return <Toggle checked={checked} onChange={setChecked} onLabel="Вкл" offLabel="Выкл" label="Тумблер" />;
}

describe('Toggle (DEV-02)', () => {
  it('состояние дублируется текстом и меняется по клику', async () => {
    render(<ToggleHarness />);
    expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByText('Выкл')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('switch'));
    expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByText('Вкл')).toBeInTheDocument();
  });
});

describe('SettingRow (DEV-02)', () => {
  it('control=toggle вызывает onToggle', async () => {
    const onToggle = vi.fn();
    render(<SettingRow label="Находимость по телефону" control="toggle" checked={false} onToggle={onToggle} />);
    await userEvent.click(screen.getByRole('switch'));
    expect(onToggle).toHaveBeenCalledWith(true);
  });

  it('control=select вызывает onSelectChange', async () => {
    const onSelectChange = vi.fn();
    render(
      <SettingRow
        label="Кто видит карточку"
        control="select"
        value="everyone"
        onSelectChange={onSelectChange}
        options={[
          { value: 'everyone', label: 'Все' },
          { value: 'nobody', label: 'Никто' },
        ]}
      />,
    );
    await userEvent.selectOptions(screen.getByLabelText('Кто видит карточку'), 'nobody');
    expect(onSelectChange).toHaveBeenCalledWith('nobody');
  });

  it('control=link рендерит кнопку и вызывает onLinkClick', async () => {
    const onLinkClick = vi.fn();
    render(<SettingRow label="Удалить аккаунт" control="link" danger onLinkClick={onLinkClick} />);
    await userEvent.click(screen.getByRole('button', { name: 'Удалить аккаунт' }));
    expect(onLinkClick).toHaveBeenCalledOnce();
  });
});

function renderProfileSettings() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const i18n = createI18n('ru');
  const router = createMemoryRouter([{ path: '/', element: <ProfileSettingsPage /> }], { initialEntries: ['/'] });
  return render(
    <QueryClientProvider client={qc}>
      <I18nextProvider i18n={i18n}>
        <RouterProvider router={router} />
      </I18nextProvider>
    </QueryClientProvider>,
  );
}

describe('ProfileSettingsPage — валидация @handle (DEV-02 §5, §9)', () => {
  beforeEach(() => {
    useAuthStore.getState().setTokens({ access: 'a', refresh: 'r' });
    useActorStore.getState().reset();
  });

  it('занятый хендл показывает «Занят», свободный — «Свободен»', async () => {
    renderProfileSettings();
    const handleInput = await screen.findByLabelText('Хендл');
    expect(handleInput).toHaveValue('@godwin');

    await userEvent.clear(handleInput);
    await userEvent.type(handleInput, '@akovalev');
    await waitFor(() => expect(screen.getByTestId('handle-availability')).toHaveTextContent('Занят'), { timeout: 3000 });

    await userEvent.clear(handleInput);
    await userEvent.type(handleInput, '@brandnewhandle1');
    await waitFor(() => expect(screen.getByTestId('handle-availability')).toHaveTextContent('Свободен'), { timeout: 3000 });
  });

  // docs/tasks/Задача_fix_web-profile-settings-real-api.md, ADR-087 — реальный
  // контракт: display_name → PATCH /users/me, handle → POST /users/me/handle
  // (apps.social, НЕ через PATCH /users/me), city → PATCH /profiles/{id}
  // (apps.profiles). Раньше «сохранение» било в about/spheres/avatarUrl,
  // которых на бэке нет вовсе, и посылало handle через несуществующий путь.
  //
  // План 11.09 §4, ADR-182: галочка «Работаю удалённо» отсюда УБРАНА (замена —
  // масштаб «По всему миру» в блоке «Где я работаю»), город — теперь честно
  // подписанная свободная подпись, не участвующая в поиске. Регион работы
  // сохраняется ОТДЕЛЬНЫМ эндпоинтом (`PUT /profiles/{id}/work-areas`), не
  // полем `PATCH /profiles/{id}` — проверяем это тем же приёмом «сохранили →
  // перезашли → видно».
  it('город и регион работы реально сохраняются — видны при повторном заходе на страницу', async () => {
    const { unmount } = renderProfileSettings();
    const cityInput = await screen.findByLabelText('Город');
    expect(cityInput).toHaveValue('Москва'); // сид pf-person-1 (profilesDb.ts)

    await userEvent.clear(cityInput);
    await userEvent.type(cityInput, 'Казань');

    await userEvent.click(await screen.findByTestId('work-areas-add'));
    await userEvent.click(await screen.findByTestId('work-area-scope-world'));
    expect(within(await screen.findByTestId('work-areas-chips')).getByText('По всему миру')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Сохранить' }));
    await waitFor(() => expect(screen.getByText('Сохранено')).toBeInTheDocument());

    unmount();
    renderProfileSettings();
    const cityInputAgain = await screen.findByLabelText('Город');
    await waitFor(() => expect(cityInputAgain).toHaveValue('Казань'));
    expect(within(await screen.findByTestId('work-areas-chips')).getByText('По всему миру')).toBeInTheDocument();

    // Галочки «Работаю удалённо» на странице больше нет вовсе (план 11.09 §4 п.3).
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
    expect(screen.queryByText(/Работаю удалённо/)).not.toBeInTheDocument();
  });

  // Страна = применимое право (ADR-182) — подпись у поля прямо говорит об
  // этом и явно исключает адрес/географию поиска, свободный город честно
  // подписан «в поиске не участвует» (владелец 11.09: развести юридический
  // адрес и поисковый).
  it('страна подписана как применимое право, город — как подпись вне поиска', async () => {
    renderProfileSettings();
    await screen.findByLabelText('Город');
    expect(
      screen.getByText('Определяет, по праву какой страны заключаются ваши договоры. Это не адрес проживания и не география поиска заказов; на валюты и налоги не влияет.'),
    ).toBeInTheDocument();
    expect(screen.getByText('Подпись на карточке — в поиске больше не участвует. Регион работы укажите ниже.')).toBeInTheDocument();
  });

  it('смена хендла — реально уходит на POST /users/me/handle, не PATCH /users/me', async () => {
    renderProfileSettings();
    const handleInput = await screen.findByLabelText('Хендл');
    await userEvent.clear(handleInput);
    await userEvent.type(handleInput, '@brandnewhandle2');
    await waitFor(() => expect(screen.getByTestId('handle-availability')).toHaveTextContent('Свободен'), { timeout: 3000 });

    await userEvent.click(screen.getByRole('button', { name: 'Сохранить' }));
    await waitFor(() => expect(screen.getByText('Сохранено')).toBeInTheDocument());

    // Перечитываем страницу — новый хендл реально персистится (не молча теряется).
    renderProfileSettings();
    await waitFor(async () => expect(await screen.findByLabelText('Хендл')).toHaveValue('@brandnewhandle2'));
  });

  it('409 handle_taken при сабмите — понятная ошибка, не крашится', async () => {
    renderProfileSettings();
    const handleInput = await screen.findByLabelText('Хендл');
    await userEvent.clear(handleInput);
    await userEvent.type(handleInput, '@brandnewhandle3');
    await waitFor(() => expect(screen.getByTestId('handle-availability')).toHaveTextContent('Свободен'), { timeout: 3000 });

    // Живая проверка сказала «свободен», но сабмит (гонка) получает 409.
    server.use(
      http.post('/v1/users/me/handle', () =>
        HttpResponse.json(
          { status: 409, code: 'handle_taken', title: 'handle_taken', detail: 'Этот хендл уже занят.' },
          { status: 409, headers: { 'Content-Type': 'application/problem+json' } },
        ),
      ),
    );

    await userEvent.click(screen.getByRole('button', { name: 'Сохранить' }));
    await waitFor(() => expect(screen.getByText('Занят')).toBeInTheDocument());
    expect(screen.queryByText('Сохранено')).not.toBeInTheDocument();
  });
});
