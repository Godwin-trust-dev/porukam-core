import { useState } from 'react';
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nextProvider } from 'react-i18next';
import { createI18n } from '@porukam/i18n';
import type { WorkArea } from '@porukam/core';
import { WorkAreaEditor } from '../src/features/profile/WorkAreaEditor';
import { useAuthStore } from '../src/features/auth/authStore';

/**
 * Редактор «Где я работаю» (план 11.09 §4, ADR-182) — та же мок-геобаза, что
 * `geoDb.ts`: RU (Московская/Ленинградская область → Москва/Санкт-Петербург),
 * KZ/US/DE. Локаль зрителя для геозапросов — `getActiveLocale()`
 * (`shared/activeLocale.ts`), модульный синглтон, по умолчанию 'ru' — поэтому
 * тесты держат и интерфейс (`createI18n('ru')`), и ожидаемые подписи на
 * русском, не выставляя `setActiveLocale` вручную.
 */

function Harness({ initial = [] }: { initial?: WorkArea[] }): JSX.Element {
  const [value, setValue] = useState<WorkArea[]>(initial);
  return <WorkAreaEditor value={value} onChange={setValue} />;
}

function renderEditor(initial?: WorkArea[]) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <I18nextProvider i18n={createI18n('ru')}>
        <Harness initial={initial} />
      </I18nextProvider>
    </QueryClientProvider>,
  );
}

const WORLD: WorkArea = { id: 'wa-world', scope: 'world', location: null, created_at: '2026-01-01T00:00:00Z' };
const COUNTRY_RU: WorkArea = { id: 'wa-country', scope: 'country', location: { code: 'RU' }, created_at: '2026-01-01T00:00:00Z' };
const REGION_MOS: WorkArea = {
  id: 'wa-region',
  scope: 'region',
  location: {
    code: 'RU-MOS',
    country: 'RU',
    name: 'Московская область',
    name_latin: 'Moskovskaya oblast',
    name_i18n: { ru: 'Московская область', en: 'Moscow region' },
    display_name: 'Московская область',
  },
  created_at: '2026-01-01T00:00:00Z',
};
const CITY_MOSCOW: WorkArea = {
  id: 'wa-city-1',
  scope: 'city',
  location: {
    id: 1,
    country: 'RU',
    region: 'RU-MOS',
    region_name: 'Московская область',
    name: 'Москва',
    name_latin: 'Moskva',
    name_i18n: { ru: 'Москва', en: 'Moscow' },
    display_name: 'Москва',
    population: 12_600_000,
  },
  created_at: '2026-01-01T00:00:00Z',
};
const CITY_SPB: WorkArea = {
  id: 'wa-city-2',
  scope: 'city',
  location: {
    id: 2,
    country: 'RU',
    region: 'RU-LEN',
    region_name: 'Ленинградская область',
    name: 'Санкт-Петербург',
    name_latin: 'Sankt-Peterburg',
    name_i18n: { ru: 'Санкт-Петербург', en: 'Saint Petersburg' },
    display_name: 'Санкт-Петербург',
    population: 5_400_000,
  },
  created_at: '2026-01-01T00:00:00Z',
};

beforeEach(() => {
  useAuthStore.getState().setTokens({ access: 'a', refresh: 'r' });
});

describe('WorkAreaEditor/WorkAreaPickerSheet (план 11.09 §4, ADR-182)', () => {
  it('пустое состояние → «весь мир» через масштаб добавляет чип, шит закрывается', async () => {
    renderEditor();
    expect(screen.queryByTestId('work-areas-chips')).not.toBeInTheDocument();

    await userEvent.click(screen.getByTestId('work-areas-add'));
    await userEvent.click(await screen.findByTestId('work-area-scope-world'));

    expect(within(screen.getByTestId('work-areas-chips')).getByText('По всему миру')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('дубль того же места — понятная ошибка в шите ДО сервера, чип не дублируется, шит не закрывается', async () => {
    renderEditor([WORLD]);
    await userEvent.click(screen.getByTestId('work-areas-add'));
    await userEvent.click(await screen.findByTestId('work-area-scope-world'));

    expect(await screen.findByTestId('work-area-picker-error')).toHaveTextContent('Это место уже добавлено.');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(within(screen.getByTestId('work-areas-chips')).getAllByText('По всему миру')).toHaveLength(1);
  });

  it('лимит 5 — кнопка «Добавить место» скрыта, вместо неё понятная подсказка (не 422 сервера)', () => {
    renderEditor([WORLD, COUNTRY_RU, REGION_MOS, CITY_MOSCOW, CITY_SPB]);
    expect(screen.queryByTestId('work-areas-add')).not.toBeInTheDocument();
    expect(screen.getByText('Не больше 5 мест. Уберите одно, чтобы добавить другое.')).toBeInTheDocument();
  });

  it('удаление чипа убирает запись из списка', async () => {
    renderEditor([WORLD]);
    expect(screen.getByTestId('work-areas-chips')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Удалить: По всему миру' }));
    expect(screen.queryByTestId('work-areas-chips')).not.toBeInTheDocument();
  });

  // ADR-194 (владелец 18.09, «страны/регионы/города не отсортированы по
  // алфавиту») — сортировка теперь живёт в общих хуках `features/geo/api.ts`,
  // поэтому касается и ЭТОГО пикера, не только гео-фильтра поиска: список
  // регионов RU в моке лежит в исходном порядке [Московская, Ленинградская]
  // (`geoDb.ts`, `RAW_REGIONS`), а по алфавиту русского языка Ленинградская
  // (Л) идёт раньше Московской (М) — контрастная проверка, не совпадение.
  it('список регионов отрисован по алфавиту языка зрителя, а не в исходном порядке справочника', async () => {
    renderEditor();
    await userEvent.click(screen.getByTestId('work-areas-add'));
    await userEvent.click(await screen.findByTestId('work-area-scope-region'));
    await userEvent.click(await screen.findByTestId('work-area-country-RU'));

    const list = await screen.findByTestId('work-area-region-list');
    const codes = within(list)
      .getAllByRole('button')
      .map((el) => el.getAttribute('data-testid'));
    expect(codes).toEqual(['work-area-region-RU-LEN', 'work-area-region-RU-MOS']);
  });

  it('каскад масштаб «город» → страна → регион → город добавляет чип с полным путём', async () => {
    renderEditor();
    await userEvent.click(screen.getByTestId('work-areas-add'));
    await userEvent.click(await screen.findByTestId('work-area-scope-city'));
    await userEvent.click(await screen.findByTestId('work-area-country-RU'));
    await userEvent.click(await screen.findByTestId('work-area-region-RU-MOS'));
    await userEvent.click(await screen.findByTestId('work-area-city-1'));

    expect(within(await screen.findByTestId('work-areas-chips')).getByText('Москва, Россия')).toBeInTheDocument();
  });

  it('«не сужать» пропускает регион — город ищется по всей стране', async () => {
    renderEditor();
    await userEvent.click(screen.getByTestId('work-areas-add'));
    await userEvent.click(await screen.findByTestId('work-area-scope-city'));
    await userEvent.click(await screen.findByTestId('work-area-country-RU'));
    await userEvent.click(await screen.findByTestId('work-area-region-skip'));

    // Оба города RU (из разных регионов) видны — регион не сузил список.
    expect(await screen.findByTestId('work-area-city-1')).toBeInTheDocument();
    expect(await screen.findByTestId('work-area-city-2')).toBeInTheDocument();
  });

  // Владелец 11.09: «не попадают жители маленьких городов» — справочник от
  // 15 000 жителей (ADR-179), ответ — право указать себя КРУПНЕЕ, а не более
  // подробный справочник. Мок-датасет НЕ содержит городов меньше порога —
  // поиск несуществующего посёлка должен вернуть пусто и сразу предложить
  // регион/страну, не оставляя человека ни с чем.
  it('пустая выдача поиска города предлагает регион и страну целиком (посёлок вне справочника)', async () => {
    renderEditor();
    await userEvent.click(screen.getByTestId('work-areas-add'));
    await userEvent.click(await screen.findByTestId('work-area-scope-city'));
    await userEvent.click(await screen.findByTestId('work-area-country-RU'));
    await userEvent.click(await screen.findByTestId('work-area-region-RU-MOS'));

    await userEvent.type(screen.getByTestId('work-area-city-search'), 'Малые Вязы');

    const empty = await screen.findByTestId('work-area-city-empty', undefined, { timeout: 3000 });
    expect(within(empty).getByTestId('work-area-city-empty-region')).toHaveTextContent('Московская область');
    expect(within(empty).getByTestId('work-area-city-empty-country')).toHaveTextContent('Россия');

    await userEvent.click(within(empty).getByTestId('work-area-city-empty-region'));
    expect(within(await screen.findByTestId('work-areas-chips')).getByText('Московская область, Россия')).toBeInTheDocument();
  });
});
