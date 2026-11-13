import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { createI18n } from '@porukam/i18n';
import { SearchPage } from '../src/pages/SearchPage';
import { useAuthStore } from '../src/features/auth/authStore';
import { useActorStore } from '../src/features/actor/actorStore';

/**
 * Упрощение экрана `/search` (ADR-189, замечания владельца с прода 12.09):
 * ровно один гео-контрол (старую «Зону поиска» убрали — дублировала
 * гео-фильтр каталога), ровно одна видимая подпись у блока сфер (заголовок
 * «Сферы» и подпись поля поиска пикера «Сфера или вид работ» друг друга не
 * дублируют), пояснительные абзацы спрятаны за «?» вместо строк на экране,
 * у поля запроса нет отдельной подписи «Поиск» (дублировала заголовок
 * экрана), нет книги контактов (ADR-192 — владелец 18.09: «поиск по
 * контактам из базы порукам бессмысленный»). Остальное поведение панели
 * фильтров/адресного лукапа проверяют
 * `SearchCatalogFilters.test.tsx`/`SearchCatalogEmptyStates.test.tsx`/
 * `SearchGroupsPages.test.tsx` — здесь только раскладка и текст.
 */

function renderAt(path: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <I18nextProvider i18n={createI18n('ru')}>
        <MemoryRouter initialEntries={[path]}>
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

describe('Экран поиска после упрощения (ADR-189)', () => {
  it('ровно один гео-контрол на экране — старой «Зоны поиска» больше нет', async () => {
    renderAt('/search');
    await screen.findByTestId('search-geo-filter-open');

    // Старый выпадающий список зоны (world/country/city, ADR-114) выпилен целиком.
    expect(screen.queryByTestId('search-zone')).not.toBeInTheDocument();
    expect(screen.queryByText('Зона поиска')).not.toBeInTheDocument();

    // Остаётся ровно одна синяя кнопка гео (каталожный фильтр, ADR-184/185).
    expect(screen.getAllByTestId('search-geo-filter-open')).toHaveLength(1);
    expect(screen.getByTestId('search-geo-filter-open')).toHaveTextContent('Весь мир');
  });

  it('ровно одна подпись у блока сфер — пикер закрыт, показана только кнопка «Добавить сферу»', async () => {
    renderAt('/search');
    await screen.findByTestId('search-geo-filter-open');

    const sphereBlock = screen.getByTestId('search-sphere-filter');
    // Заголовок «Сферы» (внешняя подпись SphereChipsEditor) не рисуется — hideLabel.
    expect(within(sphereBlock).queryByText('Сферы')).not.toBeInTheDocument();
    // Пикер свёрнут по умолчанию (collapsedByDefault) — его собственная подпись
    // поля поиска («Сфера или вид работ») тоже не видна, пока по кнопке не кликнули.
    expect(within(sphereBlock).queryByText('Сфера или вид работ')).not.toBeInTheDocument();
    expect(within(sphereBlock).getByTestId('search-sphere-filter-add')).toBeInTheDocument();

    // Доступное имя блока не потеряно — ушло в aria-label обёртки (role="group").
    expect(screen.getByRole('group', { name: 'Сферы' })).toBe(sphereBlock);
  });

  it('после открытия пикера остаётся ровно одна подпись сфер — собственная подпись поля поиска', async () => {
    renderAt('/search');
    await screen.findByTestId('search-geo-filter-open');

    await userEvent.click(screen.getByTestId('search-sphere-filter-add'));

    const sphereBlock = screen.getByTestId('search-sphere-filter');
    // Заголовок блока по-прежнему не рисуется — дубля не возникло.
    expect(within(sphereBlock).queryByText('Сферы')).not.toBeInTheDocument();
    // Единственная подпись, которая появилась — подпись поля поиска пикера.
    expect(within(sphereBlock).getAllByText('Сфера или вид работ')).toHaveLength(1);
  });

  it('пояснительные абзацы спрятаны за «?» — не видны строкой на экране, раскрываются по клику', async () => {
    renderAt('/search');
    await screen.findByTestId('search-geo-filter-open');

    // Абзацы, которые раньше стояли строками на экране, больше не видны как текст страницы.
    expect(screen.queryByText(/Поиска по имени нет/)).not.toBeInTheDocument();
    expect(screen.queryByText(/можно сочетать по отдельности/)).not.toBeInTheDocument();

    // Обе «?»-подсказки на экране раскрывают ровно эти тексты по клику.
    const helpButtons = screen.getAllByTestId('field-help');
    expect(helpButtons.length).toBeGreaterThanOrEqual(2);

    await userEvent.click(helpButtons[0] as HTMLElement);
    await userEvent.click(helpButtons[1] as HTMLElement);
    expect(screen.getByText(/Поиска по имени нет/)).toBeInTheDocument();
    expect(screen.getByText(/можно сочетать по отдельности/)).toBeInTheDocument();
  });

  it('книги контактов на экране нет — ни у поля запроса, ни в стартовом состоянии (ADR-192)', async () => {
    renderAt('/search');
    await screen.findByTestId('search-geo-filter-open');

    // Вход в книгу контактов убран из ОБОИХ мест сразу: кнопки у поля запроса
    // и CTA стартового состояния каталога. Справочник контактов остался на
    // шаге «Стороны» мастера договора (`ContractNewContactPicker.test.tsx`).
    expect(screen.queryByTestId('search-contacts-open')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Из контактов' })).not.toBeInTheDocument();

    // Стартовое состояние на месте — но это заголовок + подсказка, без кнопки.
    expect(screen.getByText('Найдите исполнителя')).toBeInTheDocument();
    expect(screen.getByText('Введите запрос или выберите фильтр')).toBeInTheDocument();
  });

  it('микрокопия «?» не обещает поиск только по завершённым сделкам (владелец 18.09)', async () => {
    renderAt('/search');
    await screen.findByTestId('search-geo-filter-open');

    await userEvent.click((screen.getAllByTestId('field-help')[0] as HTMLElement));
    const hint = screen.getByText(/Поиска по имени нет/);
    // Заявленная в профиле сфера находится и БЕЗ сделок (бэк: declared_sphere_q
    // рядом с фактами сделок) — обещать обратное подсказка больше не имеет права.
    expect(hint).toHaveTextContent('Ищите по @хендлу, телефону или сфере.');
    expect(hint.textContent).not.toMatch(/завершённым сделкам/);
  });

  it('у поля запроса нет отдельной видимой подписи «Поиск» — не дублирует заголовок экрана', async () => {
    renderAt('/search');
    await screen.findByTestId('search-geo-filter-open');

    // Доступное имя есть (aria-label), но видимого текста-подписи «Поиск» рядом с полем нет.
    expect(screen.getByRole('textbox', { name: 'Поиск' })).toHaveAttribute('data-testid', 'search-input');
    expect(screen.queryByText('Поиск', { selector: 'label' })).not.toBeInTheDocument();
  });
});
