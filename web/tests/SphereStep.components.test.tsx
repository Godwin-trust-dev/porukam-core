import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nextProvider } from 'react-i18next';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { createI18n } from '@porukam/i18n';
import { SphereStep } from '../src/pages/contract-new/SphereStep';
import { useContractNewStore } from '../src/features/contractNew/draftStore';

/**
 * ADR-097, замечания отсмотра: (1) поиск нечёткий (мок зеркалит Django),
 * (2) выбор сферы и строка поиска связаны — выбор очищает строку и
 * закрывает список, повторный поиск ЗАМЕНЯЕТ сферу, (3) вид работ
 * хранится кодом (контракт GET /checklist-recommendations?workType=).
 */

function renderStep() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter([{ path: '/*', element: <SphereStep /> }], {
    initialEntries: ['/'],
  });
  return render(
    <QueryClientProvider client={qc}>
      <I18nextProvider i18n={createI18n()}>
        <RouterProvider router={router} />
      </I18nextProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  useContractNewStore.getState().reset();
});

describe('SphereStep (ADR-097) — поиск ↔ выбранная сфера', () => {
  it('выбор из поиска очищает строку; повторный поиск с опечаткой заменяет сферу', async () => {
    renderStep();
    const input = await screen.findByTestId('sphere-search');
    await userEvent.type(input, 'уборка');
    await userEvent.click(await screen.findByTestId('sphere-cleaning'));
    expect(screen.getByTestId('sphere-chosen')).toHaveTextContent('Уборка');
    expect((screen.getByTestId('sphere-search') as HTMLInputElement).value).toBe('');

    // Сфера уже выбрана — новый поиск (с опечаткой) и клик по результату
    // ЗАМЕНЯЮТ выбор, а не оставляют старую сферу.
    await userEvent.type(screen.getByTestId('sphere-search'), 'римонт');
    await userEvent.click(await screen.findByTestId('sphere-repair'));
    await waitFor(() => expect(screen.getByTestId('sphere-chosen')).toHaveTextContent('Ремонт и строительство'));
    expect(useContractNewStore.getState().sphereCode).toBe('repair');
    expect(useContractNewStore.getState().workType).toBe(''); // сброшен при смене сферы
  });

  it('выбранная сфера подсвечена в популярных чипах (aria-pressed)', async () => {
    renderStep();
    await userEvent.click(await screen.findByTestId('sphere-plumbing'));
    await waitFor(() =>
      expect(screen.getByTestId('sphere-plumbing')).toHaveAttribute('aria-pressed', 'true'),
    );
  });

  it('вид работ хранится КОДОМ и подсвечивается', async () => {
    renderStep();
    await userEvent.click(await screen.findByTestId('sphere-finishing'));
    const chip = await screen.findByTestId('work-type-finishing_tiling');
    await userEvent.click(chip);
    expect(useContractNewStore.getState().workType).toBe('finishing_tiling');
    expect(chip).toHaveAttribute('aria-pressed', 'true');
  });

  it('ADR-100: тип работ в выдаче поиска выбирается одним нажатием — сфера и вид работ вместе', async () => {
    renderStep();
    const input = await screen.findByTestId('sphere-search');
    await userEvent.type(input, 'шкаф');
    // Совпавший тип работ показан ПЕРВЫМ блоком (до сфер) с именем своей сферы.
    const hits = await screen.findByTestId('work-type-hits');
    expect(within(hits).getByText('Сборка мебели')).toBeInTheDocument();
    await userEvent.click(within(hits).getByTestId('work-type-hit-furniture_wardrobe'));
    await waitFor(() => expect(screen.getByTestId('sphere-chosen')).toHaveTextContent('Сборка мебели'));
    expect(useContractNewStore.getState().sphereCode).toBe('furniture');
    expect(useContractNewStore.getState().workType).toBe('furniture_wardrobe');
    expect((screen.getByTestId('sphere-search') as HTMLInputElement).value).toBe('');
    // Чип вида работ под сферой подсвечен.
    expect(await screen.findByTestId('work-type-furniture_wardrobe')).toHaveAttribute('aria-pressed', 'true');
  });
});

describe('SpherePicker — hideSearchLabel (двойная подпись в форме объединения, мобильный проход 25.08)', () => {
  it('подпись поиска уходит в aria-label, видимого <label> нет', async () => {
    const { SpherePicker } = await import('@porukam/ui');
    render(
      <SpherePicker
        query=""
        onQueryChange={() => {}}
        popular={[]}
        onPick={() => {}}
        searchLabel="Сфера или вид работ"
        hideSearchLabel
        searchPlaceholder="напр. «ремонт кухни»"
        popularLabel="Популярные"
        browseAllLabel="Все сферы"
        emptyHint="Ничего не нашли"
      />,
    );
    const input = screen.getByTestId('sphere-search');
    expect(input).toHaveAttribute('aria-label', 'Сфера или вид работ');
    expect(screen.queryByText('Сфера или вид работ')).not.toBeInTheDocument();
    // Доступное имя сохраняется — поле по-прежнему находится по подписи.
    expect(screen.getByLabelText('Сфера или вид работ')).toBe(input);
  });
});
