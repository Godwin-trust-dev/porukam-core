import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { http, HttpResponse } from 'msw';
import { createI18n } from '@porukam/i18n';
import { SearchPage } from '../src/pages/SearchPage';
import { useAuthStore } from '../src/features/auth/authStore';
import { useActorStore } from '../src/features/actor/actorStore';
import { server } from '../src/mocks/server';

/**
 * Разбор пустой выдачи каталога на конкретный совет (план 11.09 §7,
 * ADR-187) — вместо одной общей заглушки. Ответы `/dashboard/search` здесь
 * ЗАДАНЫ вручную (`catalogHandler`), а не через `catalogSearchDb.ts`: нужен
 * полный контроль над тем, какая КОМБИНАЦИЯ параметров непуста, чтобы
 * детерминированно попасть в каждую ветку `useCatalogEmptySuggestion`
 * (гео/сфера/опыт пересекаются в реальном мок-датасете сложнее, чем нужно
 * для проверки одной ветки за раз). Реалистичный сценарий на живом
 * мок-датасете — `SearchCatalogFilters.test.tsx`.
 */

const FAKE_ITEM = {
  profile_id: 'pf-empty-probe',
  handle: '@probe',
  display_name: 'Проверочный Профиль',
  avatar_url: null,
  completed_deals_count: 5,
  work_areas: [],
};

/** `nonEmptyWhen(params)` решает, непуста ли выдача для ЭТОГО набора query-параметров —
 * так пробные запросы (гео-расширение/снятие сферы/снятие гео/понижение опыта)
 * получают именно тот ответ, который нужен тесту, а остальные комбинации молчат «пусто». */
function catalogHandler(nonEmptyWhen: (params: URLSearchParams) => boolean) {
  return http.get('/v1/dashboard/search', ({ request }) => {
    const url = new URL(request.url);
    const nonEmpty = nonEmptyWhen(url.searchParams);
    return HttpResponse.json({
      applied_zone: 'world',
      profiles: [],
      groups: [],
      catalog: { items: nonEmpty ? [FAKE_ITEM] : [], next_cursor: null },
    });
  });
}

function LocationProbe(): JSX.Element {
  const location = useLocation();
  return <div data-testid="location-search">{location.search}</div>;
}

function renderAt(path: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <I18nextProvider i18n={createI18n('ru')}>
        <MemoryRouter initialEntries={[path]}>
          <LocationProbe />
          <Routes>
            <Route path="/search" element={<SearchPage />} />
            <Route path="/reputation/profiles/:profileId" element={<div data-testid="profile-page" />} />
            <Route path="/:handle" element={<div data-testid="card-page" />} />
          </Routes>
        </MemoryRouter>
      </I18nextProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  useAuthStore.getState().setTokens({ access: 'a', refresh: 'r' });
  useActorStore.setState({ activeProfileId: 'pf-person-1' });
});

describe('Пустая выдача каталога — конкретный совет вместо общей заглушки (план 11.09 §7, ADR-187)', () => {
  it('фильтров нет вовсе — каталог не запрашивается вовсе, стартовое состояние вместо «пока никого нет» (ADR-189, владелец 12.09)', async () => {
    // Прежнее поведение этого сценария («пока никого нет», kind: 'no-data')
    // отменено владельцем 12.09 — с этого момента экран без единого фильтра
    // вообще не зовёт каталог, см. `SearchScreenDeclutter`/`SearchCatalogFilters`.
    // Хендлер здесь ловит запрос, ЕСЛИ он вдруг улетит, — тест проверяет
    // именно ЕГО отсутствие, а не содержимое ответа.
    let catalogCalled = false;
    server.use(
      http.get('/v1/dashboard/search', ({ request }) => {
        const url = new URL(request.url);
        if (url.searchParams.has('catalog')) catalogCalled = true;
        return HttpResponse.json({ applied_zone: 'world', profiles: [], groups: [], catalog: { items: [], next_cursor: null } });
      }),
    );
    renderAt('/search');

    expect(await screen.findByText('Найдите исполнителя')).toBeInTheDocument();
    expect(screen.queryByText('Пока никого нет')).not.toBeInTheDocument();
    expect(screen.queryByTestId('search-catalog-list')).not.toBeInTheDocument();
    expect(catalogCalled).toBe(false);
  });

  it('гео сузило до нуля — «искать шире» одной кнопкой, клик расширяет фильтр и URL', async () => {
    // Город (SPB, RU-LEN) пуст, но уровень выше (регион RU-LEN без города) —
    // уже нет: тест держит именно ЭТУ комбинацию непустой, остальные — пустые.
    server.use(
      catalogHandler(
        (p) => p.get('country') === 'RU' && p.get('region') === 'RU-LEN' && !p.has('city'),
      ),
    );
    renderAt('/search?country=RU&region=RU-LEN&city=2');

    const button = await screen.findByRole('button', { name: 'Искать: Ленинградская область, Россия' });
    expect(screen.getByText('Здесь никого не нашлось')).toBeInTheDocument();

    await userEvent.click(button);

    await waitFor(() => expect(screen.getByTestId('location-search')).not.toHaveTextContent('city='));
    expect(screen.getByTestId('location-search')).toHaveTextContent('region=RU-LEN');
    const list = await screen.findByTestId('search-catalog-list');
    expect(within(list).getByText('Проверочный Профиль')).toBeInTheDocument();
  });

  it('сфера сузила до нуля именно в этом месте — гео не помогает, предлагаем только «убрать сферу»', async () => {
    server.use(
      catalogHandler((p) => p.get('country') === 'RU' && !p.has('sphere')),
    );
    renderAt('/search?country=RU&sphere=cleaning');

    expect(await screen.findByText('По этой сфере здесь никого нет')).toBeInTheDocument();
    const removeSphere = screen.getByRole('button', { name: 'Убрать фильтр сферы' });
    expect(screen.queryByRole('button', { name: 'Искать по всему миру' })).not.toBeInTheDocument();

    await userEvent.click(removeSphere);

    await waitFor(() => expect(screen.getByTestId('location-search')).not.toHaveTextContent('sphere'));
    expect(screen.getByTestId('location-search')).toHaveTextContent('country=RU');
    const list = await screen.findByTestId('search-catalog-list');
    expect(within(list).getByText('Проверочный Профиль')).toBeInTheDocument();
  });

  it('сфера сузила до нуля — сфера не помогает нигде рядом, помогает только «убрать гео»', async () => {
    server.use(
      catalogHandler((p) => !p.has('country') && p.get('sphere') === 'cleaning'),
    );
    renderAt('/search?country=RU&region=RU-LEN&city=2&sphere=cleaning');

    expect(await screen.findByText('По этой сфере здесь никого нет')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Убрать фильтр сферы' })).not.toBeInTheDocument();
    const removeGeo = screen.getByRole('button', { name: 'Искать по всему миру' });

    await userEvent.click(removeGeo);

    await waitFor(() => expect(screen.getByTestId('location-search')).not.toHaveTextContent('country'));
    expect(screen.getByTestId('location-search')).toHaveTextContent('sphere=cleaning');
  });

  it('сфера сузила до нуля — помогает и то, и другое по отдельности — два действия сразу', async () => {
    server.use(
      catalogHandler((p) => {
        const geoWiden = p.get('country') === 'RU' && p.get('region') === 'RU-LEN' && !p.has('city') && p.get('sphere') === 'cleaning';
        if (geoWiden) return false; // расширение геo на один уровень само по себе не помогает
        const sphereRemoved = p.get('country') === 'RU' && p.get('region') === 'RU-LEN' && p.get('city') === '2' && !p.has('sphere');
        const geoRemoved = !p.has('country') && p.get('sphere') === 'cleaning';
        return sphereRemoved || geoRemoved;
      }),
    );
    renderAt('/search?country=RU&region=RU-LEN&city=2&sphere=cleaning');

    expect(await screen.findByText('По этой сфере здесь никого нет')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Убрать фильтр сферы' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Искать по всему миру' })).toBeInTheDocument();
  });

  it('порог опыта отсекает всех — предлагаем ближайший меньший пресет, а не «любой опыт»', async () => {
    server.use(catalogHandler((p) => p.get('experience_min') === '3'));
    renderAt('/search?experience_min=5');

    const button = await screen.findByRole('button', { name: 'Снизить порог: 3+ завершённых сделок' });
    expect(screen.getByText('С таким опытом здесь пока пусто')).toBeInTheDocument();

    await userEvent.click(button);

    await waitFor(() => expect(screen.getByTestId('location-search')).toHaveTextContent('experience_min=3'));
    expect(screen.getByTestId('search-experience-filter')).toHaveValue('3');
  });

  it('порог опыта на минимальном пресете — дальше снижать некуда, предлагаем «любой опыт»', async () => {
    server.use(catalogHandler((p) => !p.has('experience_min')));
    renderAt('/search?experience_min=1');

    const button = await screen.findByRole('button', { name: 'Снизить порог: Любой опыт' });
    await userEvent.click(button);

    await waitFor(() => expect(screen.getByTestId('location-search')).not.toHaveTextContent('experience_min'));
    expect(screen.getByTestId('search-experience-filter')).toHaveValue('');
  });

  it('несколько фильтров сразу — ни одно точечное ослабление не помогает — прежний общий сброс', async () => {
    server.use(catalogHandler(() => false));
    renderAt('/search?country=RU&region=RU-LEN&city=2&sphere=cleaning&experience_min=5');

    expect(await screen.findByText('Никого не нашлось')).toBeInTheDocument();
    expect(screen.getByText('Попробуйте снять часть фильтров — например, регион или порог опыта.')).toBeInTheDocument();
    const reset = screen.getAllByRole('button', { name: 'Сбросить фильтры' });
    expect(reset.length).toBeGreaterThan(0);

    await userEvent.click(reset[reset.length - 1] as HTMLElement);

    // После сброса фильтров нет вовсе — каталог больше не запрашивается
    // (ADR-189, владелец 12.09): вместо «пока никого нет» снова стартовое
    // состояние экрана, а не список и не сетевой запрос.
    await waitFor(() => expect(screen.getByTestId('location-search').textContent).toBe(''));
    expect(await screen.findByText('Найдите исполнителя')).toBeInTheDocument();
    expect(screen.queryByText('Пока никого нет')).not.toBeInTheDocument();
  });
});
