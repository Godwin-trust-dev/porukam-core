import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { createI18n } from '@porukam/i18n';
import { SearchPage } from '../src/pages/SearchPage';
import { useAuthStore } from '../src/features/auth/authStore';
import { useActorStore } from '../src/features/actor/actorStore';

/**
 * Гео-фильтр каталога после ADR-194 (замечания владельца 18.09):
 * 1) остановиться на любом уровне («невозможно остановить поиск на стране
 *    например или регионе... так не должно быть») — липкая кнопка
 *    `geo-filter-apply-current`;
 * 2) сортировка справочника по алфавиту языка зрителя («старны/регионы/
 *    города не отсортированы по алфавиту»);
 * 3) глобальный поиск города на шаге «Страна» («вводит город а ему сразу
 *    подставляют регион»);
 * 4) деление каталожной выдачи на «В выбранном месте» / «Работают удалённо»
 *    (`geo_match`, мок — `catalogSearchDb.ts`).
 *
 * Каскад (шаги/навигация) уже покрыт `SearchCatalogFilters.test.tsx` —
 * здесь только НОВОЕ поведение этой ветки.
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

describe('Гео-фильтр каталога: алфавит зрителя (ADR-194)', () => {
  it('страны отрисованы по алфавиту русского языка, не в исходном порядке справочника', async () => {
    // Мок `MOCK_COUNTRIES` (geoDb.ts) лежит в порядке [RU, KZ, US, DE] — по
    // алфавиту русских названий (Германия/Казахстан/Россия/Соединенные Штаты)
    // порядок ДРУГОЙ: контрастная проверка, не совпадение.
    renderAt('/search');
    await userEvent.click(screen.getByTestId('search-geo-filter-open'));

    const list = await screen.findByTestId('geo-filter-country-list');
    const codes = within(list)
      .getAllByRole('button')
      .map((el) => el.getAttribute('data-testid'));
    expect(codes).toEqual(['geo-filter-country-DE', 'geo-filter-country-KZ', 'geo-filter-country-RU', 'geo-filter-country-US']);
  });

  it('регионы отрисованы по алфавиту русского языка, не в исходном порядке справочника', async () => {
    // RAW_REGIONS RU лежит как [Московская, Ленинградская] — по алфавиту
    // (Л < М) порядок обратный.
    renderAt('/search');
    await userEvent.click(screen.getByTestId('search-geo-filter-open'));
    await userEvent.click(await screen.findByTestId('geo-filter-country-RU'));

    const list = await screen.findByTestId('geo-filter-region-list');
    const codes = within(list)
      .getAllByRole('button')
      .map((el) => el.getAttribute('data-testid'));
    expect(codes).toEqual(['geo-filter-region-RU-LEN', 'geo-filter-region-RU-MOS']);
  });
});

describe('Гео-фильтр каталога: остановиться на любом уровне (ADR-194, владелец 18.09 п.2)', () => {
  it('липкая кнопка на шаге «Регион» применяет фильтр СТРАНЫ — в URL только country', async () => {
    renderAt('/search');
    await userEvent.click(screen.getByTestId('search-geo-filter-open'));
    await userEvent.click(await screen.findByTestId('geo-filter-country-RU'));

    const apply = await screen.findByTestId('geo-filter-apply-current');
    expect(apply).toHaveTextContent('Показать: Россия');
    await userEvent.click(apply);

    await waitFor(() => expect(screen.getByTestId('location-search')).toHaveTextContent('country=RU'));
    expect(screen.getByTestId('location-search')).not.toHaveTextContent('region');
    expect(screen.getByTestId('location-search')).not.toHaveTextContent('city');
    // Шит закрылся сам (тот же приём, что «Выбрать» у FilterSheet).
    expect(screen.queryByTestId('geo-filter-apply-current')).not.toBeInTheDocument();
  });

  it('липкая кнопка на шаге «Город» применяет фильтр РЕГИОНА — в URL country + region, без city', async () => {
    renderAt('/search');
    await userEvent.click(screen.getByTestId('search-geo-filter-open'));
    await userEvent.click(await screen.findByTestId('geo-filter-country-RU'));
    await userEvent.click(await screen.findByTestId('geo-filter-region-RU-MOS'));

    const apply = await screen.findByTestId('geo-filter-apply-current');
    expect(apply).toHaveTextContent('Показать: Московская область');
    await userEvent.click(apply);

    await waitFor(() => expect(screen.getByTestId('location-search')).toHaveTextContent('country=RU'));
    expect(screen.getByTestId('location-search')).toHaveTextContent('region=RU-MOS');
    expect(screen.getByTestId('location-search')).not.toHaveTextContent('city=');
  });

  it('прежних строк-дублей «Вся страна» / «Только регион» в потоке шагов больше нет', async () => {
    // «Не сужать» (`geo-filter-region-skip`) — это НАВИГАЦИЯ, а не применение
    // фильтра, и она НЕ убиралась (см. describe ниже) — регрессия 18.09,
    // исправлена той же сессией. Убраны были только строки-дубли липкой
    // кнопки: «Вся страна: X» (`geo-filter-country-apply`, шаг «Регион») и
    // «Только X, без города» (`geo-filter-region-apply`, шаг «Город»).
    renderAt('/search');
    await userEvent.click(screen.getByTestId('search-geo-filter-open'));
    await userEvent.click(await screen.findByTestId('geo-filter-country-RU'));

    expect(screen.queryByTestId('geo-filter-country-apply')).not.toBeInTheDocument();

    await userEvent.click(await screen.findByTestId('geo-filter-region-RU-MOS'));
    expect(screen.queryByTestId('geo-filter-region-apply')).not.toBeInTheDocument();
  });
});

describe('Гео-фильтр каталога: переход к городам всей страны, минуя регион (ADR-194, исправление регрессии)', () => {
  it('со шага «Регион» кнопка ведёт на список городов ВСЕЙ страны, без региона в запросе', async () => {
    // Человек, который выбрал страну и хочет конкретный город, не обязан
    // сперва знать область (владелец: «обязан сперва знать область» — баг).
    // Прежняя формулировка обещала применить фильтр — теперь честная:
    // «Не знаю регион — показать города страны» (dashboard.searchGeoRegionSkipToCities).
    renderAt('/search');
    await userEvent.click(screen.getByTestId('search-geo-filter-open'));
    await userEvent.click(await screen.findByTestId('geo-filter-country-RU'));

    const skip = await screen.findByTestId('geo-filter-region-skip');
    expect(skip).toHaveTextContent('Не знаю регион — показать города страны');
    await userEvent.click(skip);

    // Оба города RU (из разных регионов) видны — регион не сузил список.
    expect(await screen.findByTestId('geo-filter-city-1')).toBeInTheDocument();
    expect(await screen.findByTestId('geo-filter-city-2')).toBeInTheDocument();
  });

  it('липкая кнопка на шаге «Город» без выбранного региона (после «Не знаю регион») показывает «Показать: <страна>»', async () => {
    renderAt('/search');
    await userEvent.click(screen.getByTestId('search-geo-filter-open'));
    await userEvent.click(await screen.findByTestId('geo-filter-country-RU'));
    await userEvent.click(await screen.findByTestId('geo-filter-region-skip'));

    const apply = await screen.findByTestId('geo-filter-apply-current');
    expect(apply).toHaveTextContent('Показать: Россия');
    await userEvent.click(apply);

    await waitFor(() => expect(screen.getByTestId('location-search')).toHaveTextContent('country=RU'));
    expect(screen.getByTestId('location-search')).not.toHaveTextContent('region');
    expect(screen.getByTestId('location-search')).not.toHaveTextContent('city');
  });
});

describe('Гео-фильтр каталога: глобальный поиск города на шаге «Страна» (ADR-194, владелец 18.09 п.3)', () => {
  it('выбор города из глобального поля кладёт в URL страну, регион и город сразу', async () => {
    renderAt('/search');
    await userEvent.click(screen.getByTestId('search-geo-filter-open'));

    // Шаг «Страна» — страну выбирать не нужно вовсе.
    await userEvent.type(await screen.findByTestId('geo-filter-global-city-search'), 'Алматы');

    const row = await screen.findByTestId('geo-filter-global-city-3');
    expect(row).toHaveTextContent('Алматы · Алматинская область, Казахстан');
    await userEvent.click(row);

    await waitFor(() => expect(screen.getByTestId('location-search')).toHaveTextContent('country=KZ'));
    expect(screen.getByTestId('location-search')).toHaveTextContent('region=KZ-ALM');
    expect(screen.getByTestId('location-search')).toHaveTextContent('city=3');
    expect(screen.queryByTestId('search-geo-filter-open')).toHaveTextContent('Алматы, Казахстан');
  });

  it('без строки поиска глобальный список не рисуется и бэк не дёргается', async () => {
    renderAt('/search');
    await userEvent.click(screen.getByTestId('search-geo-filter-open'));
    await screen.findByTestId('geo-filter-global-city-search');

    expect(screen.queryByTestId('geo-filter-global-city-list')).not.toBeInTheDocument();
  });
});

describe('Каталог исполнителей: два блока по geo_match (ADR-194, владелец 18.09 — «десктоп_поиск.png»)', () => {
  it('местных нет — «В выбранном месте» показывает «пока никого», «Работают удалённо» — мировой профиль', async () => {
    // Ни один мок-профиль (`catalogSearchDb.ts`) не заявлен в US — только
    // Ли Вэй (`scope: 'world'`), совпадающий с ЛЮБЫМ гео-фильтром как
    // «работает удалённо».
    renderAt('/search?country=US');

    await screen.findByTestId('search-catalog-list');
    expect(screen.queryByTestId('search-catalog-list-local')).not.toBeInTheDocument();
    expect(screen.getByTestId('search-catalog-list-local-empty')).toHaveTextContent('Пока никого');

    const remote = screen.getByTestId('search-catalog-list-remote');
    expect(within(remote).getByText('Ли Вэй')).toBeInTheDocument();
  });

  it('местные и удалённые вместе — два раздела', async () => {
    renderAt('/search?country=KZ');

    const local = await screen.findByTestId('search-catalog-list-local');
    expect(within(local).getByText('Ерлан Байтасов')).toBeInTheDocument();
    expect(within(local).getByText('Гульнара Ахметова')).toBeInTheDocument();
    expect(within(local).getByText('Данияр Сериков')).toBeInTheDocument();

    const remote = screen.getByTestId('search-catalog-list-remote');
    expect(within(remote).getByText('Ли Вэй')).toBeInTheDocument();
    expect(within(remote).queryByText('Ерлан Байтасов')).not.toBeInTheDocument();
  });

  it('без гео-фильтра деления на два блока нет — список остаётся один', async () => {
    renderAt('/search?experience_min=1');
    const list = await screen.findByTestId('search-catalog-list');
    expect(screen.queryByTestId('search-catalog-list-local')).not.toBeInTheDocument();
    expect(screen.queryByTestId('search-catalog-list-remote')).not.toBeInTheDocument();
    expect(within(list).getByText('Ли Вэй')).toBeInTheDocument();
  });
});

/**
 * Кнопка «искать шире» в пустом блоке «В выбранном месте» — решение владельца
 * после ADR-194 («да, добавь кнопку „искать шире“»): та же механика, что уже
 * применяет пустая выдача каталога целиком (`widenGeoFilter`, `widen-geo`,
 * ADR-187) — БЕЗ проб-запроса (`probeCatalogNonEmpty`), блок пуст не
 * «вообще», а только по местным, расширение предлагается безусловно.
 */
describe('Каталог исполнителей: «искать шире» в пустом блоке «В выбранном месте»', () => {
  it('фильтр уровня страны — кнопка снимает country из URL (фильтр становится «весь мир»)', async () => {
    // Ни один мок-профиль не заявлен в US — местных нет, только мировой Ли Вэй.
    renderAt('/search?country=US');

    await screen.findByTestId('search-catalog-list-local-empty');
    const widen = screen.getByTestId('search-catalog-local-empty-widen');
    expect(widen).toBeInTheDocument();

    await userEvent.click(widen);

    await waitFor(() => expect(screen.getByTestId('location-search')).not.toHaveTextContent('country'));
    expect(screen.getByTestId('location-search')).not.toHaveTextContent('region');
    expect(screen.getByTestId('location-search')).not.toHaveTextContent('city');
  });

  it('фильтр уровня города — кнопка оставляет country и region, убирает только city', async () => {
    // US/Калифорния/Лос-Анджелес (id 4) — ни один мок-профиль не заявлен в
    // США, местных на уровне города нет, мировой Ли Вэй — есть.
    renderAt('/search?country=US&region=US-CA&city=4');

    await screen.findByTestId('search-catalog-list-local-empty');
    await userEvent.click(screen.getByTestId('search-catalog-local-empty-widen'));

    await waitFor(() => expect(screen.getByTestId('location-search')).not.toHaveTextContent('city='));
    expect(screen.getByTestId('location-search')).toHaveTextContent('country=US');
    expect(screen.getByTestId('location-search')).toHaveTextContent('region=US-CA');
  });
});
