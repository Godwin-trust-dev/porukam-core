import { beforeEach, describe, expect, it } from 'vitest';
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
 * Каталог исполнителей на `/search` (план 11.09 §6, ADR-184/185) — гео-каскад
 * (`GeoFilterSheet`), синхронизация фильтров с URL, пустая выдача и
 * keyset-подгрузка. Панель фильтров и мок-датасет (`catalogSearchDb.ts`) уже
 * покрыты `SearchGroupsPages.test.tsx` для адресного лукапа по `q` — здесь
 * ровно недостающая ветка `catalog`.
 */

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

describe('Каталог исполнителей: панель фильтров (план 11.09 §6, ADR-184/185)', () => {
  it('без единого фильтра — каталог не запрашивается, показано стартовое состояние (ADR-189, владелец 12.09)', async () => {
    renderAt('/search');
    await screen.findByTestId('search-geo-filter-open');

    // Список не рисуется вовсе — ни скелетон, ни выдача.
    expect(screen.queryByTestId('search-catalog-list')).not.toBeInTheDocument();
    expect(screen.getByText('Найдите исполнителя')).toBeInTheDocument();
  });

  it('с любым заданным фильтром — «весь мир» без гео: показаны все подходящие мок-профили, страниц больше нет', async () => {
    // experience_min=1 — самый нейтральный фильтр (не сужает гео/сферу), но
    // уже включает выдачу: подтверждает, что «весь мир» (ADR-185) на уровне
    // API не отменён, отменено только автоматическое обращение к нему БЕЗ
    // единого фильтра (ADR-189).
    renderAt('/search?experience_min=1');
    const list = await screen.findByTestId('search-catalog-list');
    // Мировой профиль (scope: 'world') подходит под любой запрос без гео-фильтра.
    expect(within(list).getByText('Ли Вэй')).toBeInTheDocument();
    expect(within(list).getByText('Ерлан Байтасов')).toBeInTheDocument();
    expect(within(list).getByText('Hans Weber')).toBeInTheDocument();
    // Игорь Кузнецов (0 завершённых сделок) отсекается порогом опыта — 7 из 8.
    expect(within(list).queryByText('Игорь Кузнецов')).not.toBeInTheDocument();
    expect(screen.queryByTestId('search-catalog-show-more')).not.toBeInTheDocument();
  });

  it('гео-каскад: страна сужает список регионов, регион — список городов', async () => {
    renderAt('/search');
    await userEvent.click(screen.getByTestId('search-geo-filter-open'));

    const countries = await screen.findByTestId('geo-filter-country-list');
    expect(within(countries).getByTestId('geo-filter-country-RU')).toBeInTheDocument();
    expect(within(countries).getByTestId('geo-filter-country-KZ')).toBeInTheDocument();

    await userEvent.click(within(countries).getByTestId('geo-filter-country-RU'));

    const regions = await screen.findByTestId('geo-filter-region-list');
    expect(within(regions).getByText('Московская область')).toBeInTheDocument();
    expect(within(regions).getByText('Ленинградская область')).toBeInTheDocument();
    // Регион другой страны каскад не подмешивает.
    expect(within(regions).queryByText('Алматинская область')).not.toBeInTheDocument();

    await userEvent.click(screen.getByTestId('geo-filter-region-RU-MOS'));

    const cities = await screen.findByTestId('geo-filter-city-list');
    expect(within(cities).getByText('Москва')).toBeInTheDocument();
    // Санкт-Петербург — другой регион (RU-LEN), город региона не подмешивает.
    expect(within(cities).queryByText('Санкт-Петербург')).not.toBeInTheDocument();
  });

  it('смена страны сбрасывает регион и поисковую строку региона (не остаток от прошлой страны)', async () => {
    renderAt('/search');
    await userEvent.click(screen.getByTestId('search-geo-filter-open'));
    await userEvent.click(await screen.findByTestId('geo-filter-country-RU'));

    await userEvent.type(screen.getByTestId('geo-filter-region-search'), 'Моск');
    // Дебаунс (250мс, `useDebounced`) — ждём, пока «Ленинградская» уйдёт из
    // списка, а не проверяем сразу (она видна до применения фильтра).
    await waitFor(() => expect(screen.queryByText('Ленинградская область')).not.toBeInTheDocument());
    expect(screen.getByText('Московская область')).toBeInTheDocument();

    await userEvent.click(screen.getByTestId('geo-filter-back'));
    await userEvent.click(await screen.findByTestId('geo-filter-country-KZ'));

    // Поисковая строка региона — снова пустая, а не «Моск» от предыдущей страны.
    expect(screen.getByTestId('geo-filter-region-search')).toHaveValue('');
    // Дебаунс сбрасывается вместе со строкой — ждём, пока полный список
    // регионов KZ придёт (пустая строка запроса, без остатка «Моск»).
    await waitFor(() => expect(within(screen.getByTestId('geo-filter-region-list')).getByText('Алматинская область')).toBeInTheDocument());
  });

  it('URL → фильтры: прямая ссылка с параметрами разворачивает панель и сужает выдачу', async () => {
    // Ерлан — Алматы (KZ), сфера repair, 6 сделок; страна+сфера+опыт сужают
    // выдачу ровно до него (Гульнара из того же города — сфера cleaning,
    // Данияр — гео KZ, но сфера electrical, оба исключаются сферой).
    renderAt('/search?country=KZ&sphere=repair&experience_min=3');

    expect(screen.getByTestId('search-geo-filter-open')).toHaveTextContent('Казахстан');
    expect(screen.getByTestId('search-experience-filter')).toHaveValue('3');

    const list = await screen.findByTestId('search-catalog-list');
    expect(within(list).getByText('Ерлан Байтасов')).toBeInTheDocument();
    expect(within(list).queryByText('Гульнара Ахметова')).not.toBeInTheDocument();
    expect(within(list).queryByText('Данияр Сериков')).not.toBeInTheDocument();
    // Марат — та же сфера и опыт, но Москва (RU) — вне гео-фильтра по KZ.
    expect(within(list).queryByText('Марат Отделкин')).not.toBeInTheDocument();
  });

  it('фильтры → URL: изменение панели пишет параметры в адресную строку, сброс их убирает', async () => {
    renderAt('/search');
    // Без фильтра список не рисуется вовсе (ADR-189) — ждём саму панель, не выдачу.
    await screen.findByTestId('search-geo-filter-open');
    expect(screen.queryByTestId('search-catalog-list')).not.toBeInTheDocument();

    await userEvent.selectOptions(screen.getByTestId('search-experience-filter'), '3');
    await waitFor(() => expect(screen.getByTestId('location-search')).toHaveTextContent('experience_min=3'));
    // Фильтр появился — теперь список запрашивается и рисуется.
    await screen.findByTestId('search-catalog-list');

    await userEvent.click(screen.getByTestId('search-catalog-reset'));
    await waitFor(() => expect(screen.getByTestId('location-search')).not.toHaveTextContent('experience_min'));
    expect(screen.queryByTestId('search-catalog-reset')).not.toBeInTheDocument();
    // Фильтров снова нет — список исчез, вернулось стартовое состояние.
    expect(screen.queryByTestId('search-catalog-list')).not.toBeInTheDocument();
  });

  it('пустая выдача, которую точечно не починить — общий сброс (несуществующая сфера + порог опыта выше, чем у всех в KZ)', async () => {
    // Разбор пустой выдачи на конкретный совет (план 11.09 §7, ADR-187) для
    // единичных случаев — в `SearchCatalogEmptyStates.test.tsx` (гео/сфера/
    // опыт по отдельности, на детерминированных ответах сервера). Здесь —
    // регресс на РЕАЛЬНОМ мок-датасете: сфера не существует нигде вовсе, а
    // порог 10 отсекает даже мировой профиль (9 сделок) — ни расширение гео,
    // ни снятие сферы/понижение порога не помогают по отдельности, остаётся
    // прежнее общее поведение.
    renderAt('/search?country=KZ&sphere=nonexistent_sphere&experience_min=10');

    expect(await screen.findByText('Никого не нашлось')).toBeInTheDocument();
    expect(screen.queryByTestId('search-catalog-list')).not.toBeInTheDocument();

    // Кнопка сброса есть и в панели (пока активны фильтры), и в самом
    // `EmptyState` — обе с одним текстом, различаем по testid панели.
    await userEvent.click(screen.getByTestId('search-catalog-reset'));

    // Фильтров больше нет вовсе — список не возвращается «весь мир» сам по
    // себе (ADR-189, владелец 12.09): вместо него снова стартовое состояние.
    await waitFor(() => expect(screen.getByTestId('search-geo-filter-open')).toHaveTextContent('Весь мир'));
    expect(screen.queryByTestId('search-catalog-list')).not.toBeInTheDocument();
    expect(screen.getByText('Найдите исполнителя')).toBeInTheDocument();
  });

  it('подгрузка следующей страницы по курсору — старые строки не теряются, курсор уходит на сервер', async () => {
    server.use(
      http.get('/v1/dashboard/search', ({ request }) => {
        const url = new URL(request.url);
        const cursor = url.searchParams.get('cursor');
        if (!cursor) {
          return HttpResponse.json({
            applied_zone: 'world',
            profiles: [],
            groups: [],
            catalog: {
              items: [
                { profile_id: 'pf-page-1', handle: '@page1', display_name: 'Страница Один', avatar_url: null, completed_deals_count: 1, work_areas: [] },
                { profile_id: 'pf-page-2', handle: '@page2', display_name: 'Страница Два', avatar_url: null, completed_deals_count: 2, work_areas: [] },
              ],
              next_cursor: 'CURSOR-2',
            },
          });
        }
        expect(cursor).toBe('CURSOR-2');
        return HttpResponse.json({
          applied_zone: 'world',
          profiles: [],
          groups: [],
          catalog: {
            items: [{ profile_id: 'pf-page-3', handle: '@page3', display_name: 'Страница Три', avatar_url: null, completed_deals_count: 3, work_areas: [] }],
            next_cursor: null,
          },
        });
      }),
    );

    // Фильтр в URL — без него каталог не запрашивается вовсе (ADR-189).
    renderAt('/search?experience_min=1');
    const list = await screen.findByTestId('search-catalog-list');
    expect(within(list).getByText('Страница Один')).toBeInTheDocument();
    expect(within(list).getByText('Страница Два')).toBeInTheDocument();
    expect(screen.getByTestId('search-catalog-show-more')).toBeInTheDocument();

    await userEvent.click(screen.getByTestId('search-catalog-show-more'));

    await waitFor(() => expect(within(screen.getByTestId('search-catalog-list')).getByText('Страница Три')).toBeInTheDocument());
    expect(within(screen.getByTestId('search-catalog-list')).getByText('Страница Один')).toBeInTheDocument();
    expect(screen.queryByTestId('search-catalog-show-more')).not.toBeInTheDocument();
  });
});

/**
 * Фильтр по видам работ (ADR-190/191) — `work_type=`, повторяемый параметр,
 * составные коды `<сфера>.<категория>`, тот же мок-датасет `catalogSearchDb.ts`
 * (`pf-catalog-almaty-repair` — repair.repair_kitchen + finishing.finishing_tiling;
 * `pf-catalog-moscow-furniture` — furniture.furniture_wardrobe + repair.repair_kitchen).
 * ИЛИ между значениями, И с остальными фильтрами (сфера/гео) — как на бэке
 * (ADR-190 §3, `apps.dashboards`).
 */
describe('Каталог исполнителей: фильтр по видам работ (ADR-190/191)', () => {
  it('один вид работ в URL — находит все профили с этим кодом, независимо от сферы-фильтра', async () => {
    renderAt('/search?work_type=repair.repair_kitchen');
    const list = await screen.findByTestId('search-catalog-list');
    expect(within(list).getByText('Ерлан Байтасов')).toBeInTheDocument();
    expect(within(list).getByText('Марат Отделкин')).toBeInTheDocument();
    expect(within(list).queryByText('Ли Вэй')).not.toBeInTheDocument();
  });

  it('несколько видов работ — ИЛИ между значениями', async () => {
    // Единственный носитель finishing.finishing_tiling — Ерлан; furniture.furniture_wardrobe — Марат.
    renderAt('/search?work_type=finishing.finishing_tiling&work_type=furniture.furniture_wardrobe');
    const list = await screen.findByTestId('search-catalog-list');
    expect(within(list).getByText('Ерлан Байтасов')).toBeInTheDocument();
    expect(within(list).getByText('Марат Отделкин')).toBeInTheDocument();
  });

  it('вид работ + сфера — И между осями (оба условия сразу)', async () => {
    // sphere=repair подходит и Ерлану, и Марату; finishing.finishing_tiling — только Ерлану.
    renderAt('/search?sphere=repair&work_type=finishing.finishing_tiling');
    const list = await screen.findByTestId('search-catalog-list');
    expect(within(list).getByText('Ерлан Байтасов')).toBeInTheDocument();
    expect(within(list).queryByText('Марат Отделкин')).not.toBeInTheDocument();
  });

  it('вид работ + гео — И между осями', async () => {
    // repair.repair_kitchen подходит Ерлану (Алматы, KZ) и Марату (Москва, RU);
    // country=RU оставляет только Марата.
    renderAt('/search?country=RU&work_type=repair.repair_kitchen');
    const list = await screen.findByTestId('search-catalog-list');
    expect(within(list).getByText('Марат Отделкин')).toBeInTheDocument();
    expect(within(list).queryByText('Ерлан Байтасов')).not.toBeInTheDocument();
  });

  it('панель: вид работ разворачивается ТОЛЬКО под выбранной сферой, выбор пишется в URL как `work_type=`', async () => {
    renderAt('/search');
    await screen.findByTestId('search-geo-filter-open');

    // Без выбранной сферы блока видов работ нет вовсе.
    expect(screen.queryByTestId('search-work-type-filter')).not.toBeInTheDocument();

    await userEvent.click(screen.getByTestId('search-sphere-filter-add'));
    await userEvent.click(await screen.findByTestId('sphere-repair'));

    const workTypeGroup = await screen.findByTestId('search-work-type-filter-group-repair');
    expect(within(workTypeGroup).getByText('Ремонт кухни')).toBeInTheDocument();

    await userEvent.click(within(workTypeGroup).getByTestId('work-type-repair.repair_kitchen'));
    await waitFor(() => expect(screen.getByTestId('location-search')).toHaveTextContent('work_type=repair.repair_kitchen'));
    // Сфера-фильтр в том же URL — оба условия сосуществуют независимо.
    expect(screen.getByTestId('location-search')).toHaveTextContent('sphere=repair');
  });

  it('снятие сферы фильтра сразу убирает и её виды работ из URL', async () => {
    renderAt('/search?sphere=repair&work_type=repair.repair_kitchen');
    await screen.findByTestId('search-catalog-list');
    expect(await screen.findByTestId('search-work-type-filter-group-repair')).toBeInTheDocument();

    // Снятие единственной выбранной сферы через чип `SphereChipsEditor`.
    const sphereBlock = screen.getByTestId('search-sphere-filter');
    await userEvent.click(within(sphereBlock).getByRole('button', { name: /Убрать сферу/ }));

    await waitFor(() => expect(screen.getByTestId('location-search')).not.toHaveTextContent('work_type'));
    expect(screen.getByTestId('location-search')).not.toHaveTextContent('sphere=repair');
    expect(screen.queryByTestId('search-work-type-filter-group-repair')).not.toBeInTheDocument();
  });

  it('сброс всех фильтров панели убирает и `work_type` из URL', async () => {
    renderAt('/search?sphere=repair&work_type=repair.repair_kitchen');
    await screen.findByTestId('search-catalog-list');

    await userEvent.click(screen.getByTestId('search-catalog-reset'));
    await waitFor(() => expect(screen.getByTestId('location-search')).not.toHaveTextContent('work_type'));
    expect(screen.getByTestId('location-search')).not.toHaveTextContent('sphere');
  });
});
