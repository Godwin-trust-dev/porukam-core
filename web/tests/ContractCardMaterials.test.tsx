import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { pickSearchOption } from './pickSearchOption';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { createI18n } from '@porukam/i18n';
import { ContractDetailPage } from '../src/pages/ContractDetailPage';
import { useAuthStore } from '../src/features/auth/authStore';
import { useActorStore } from '../src/features/actor/actorStore';
import { createMaterial, listMaterials } from '../src/mocks/realContractsDb';

/**
 * Материалы этапа на карточке договора (решение владельца 03.09: «если договор
 * редактируется, то должны быть возможность редактировать и материалы»).
 * До этого карточка только показывала материалы легаси-агрегата, а в реальном
 * контуре их не было вовсе.
 *
 * `rc-review-1` — под согласованием (редактируется), `rc-progress-1` —
 * подписан: там материал сида виден, но правки нет.
 */
function renderPage(path: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <I18nextProvider i18n={createI18n('ru')}>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="/contracts/:id" element={<ContractDetailPage />} />
            <Route path="/contracts/:id/stages/:sid" element={<div data-testid="stage-stub">stage</div>} />
          </Routes>
        </MemoryRouter>
      </I18nextProvider>
    </QueryClientProvider>,
  );
}

async function openStagesTab(): Promise<void> {
  await userEvent.click(screen.getByRole('tab', { name: /Этапы/ }));
}

describe('Карточка договора — материалы этапа', () => {
  beforeEach(() => {
    useAuthStore.getState().setTokens({ access: 'a', refresh: 'r' });
    useActorStore.getState().reset();
    useActorStore.getState().setProfiles([
      { id: 'pf-person-1', kind: 'person', display_name: 'Годвин', handle: '@godwin', verification_level: 'basic', has_business_status: false },
    ]);
  });

  it('пока договор редактируется: материал добавляется, правится и удаляется', async () => {
    const user = userEvent.setup();
    renderPage('/contracts/rc-review-1');
    await screen.findByText('Сборка мебели — гостиная');
    await openStagesTab();

    // Добавление: окно «Материалы» на первом этапе.
    await user.click((await screen.findAllByTestId('open-materials'))[0]!);
    await pickSearchOption(user, 'material-catalog-select', 'Плитка керамическая');
    await user.type(screen.getByLabelText('Количество'), '10');
    await user.selectOptions(screen.getByTestId('material-supplied-by'), 'customer');
    await user.type(screen.getByTestId('material-price'), '900');
    await user.click(screen.getByTestId('material-add'));
    await waitFor(() => expect(listMaterials('ms-1')).toHaveLength(1));
    const [created] = listMaterials('ms-1');

    // Правка: тот же материал, PATCH — не новая позиция.
    await user.click(await screen.findByTestId(`material-edit-srv-${created!.id}`));
    await user.selectOptions(screen.getByTestId('material-supplied-by'), 'contractor');
    await user.click(screen.getByTestId('material-add'));
    await waitFor(() => expect(listMaterials('ms-1')[0]!.source).toBe('contractor'));
    expect(listMaterials('ms-1')).toHaveLength(1);
    expect(listMaterials('ms-1')[0]!.id).toBe(created!.id);

    // Удаление.
    await user.click(await screen.findByTestId(`material-remove-srv-${created!.id}`));
    await waitFor(() => expect(listMaterials('ms-1')).toEqual([]));
  }, 20_000);

  it('материал, заведённый до подписания, виден в списке этапа', async () => {
    createMaterial('ms-1', {
      catalog_item_code: 'cat-laminate',
      description: 'Ламинат',
      source: 'customer',
      unit_price: '0.00',
      unit_price_currency: 'RUB',
      quantity: '20',
      unit: 'm2',
      delivery_days: 5,
      delivery_base: 'prepayment',
    });
    renderPage('/contracts/rc-review-1');
    await screen.findByText('Сборка мебели — гостиная');
    await openStagesTab();

    const list = await screen.findByTestId('stage-materials');
    expect(list).toHaveTextContent('Ламинат');
    expect(list).toHaveTextContent('поставляет: Заказчик');
    expect(list).toHaveTextContent('предоплаты');
  }, 20_000);

  it('после заморозки: правки нет, зато виден протокол передачи (ADR-155)', async () => {
    renderPage('/contracts/rc-progress-1');
    await screen.findByText('Ремонт ванной комнаты');
    await openStagesTab();

    // Материалы есть у двух листьев этого договора (`ms-3` — полученная
    // плитка, `ms-3-suspended` — кабель, который ещё ждут), поэтому список
    // на карточке не один.
    const lists = await screen.findAllByTestId('stage-materials');
    const text = lists.map((l) => l.textContent ?? '').join(' | ');
    expect(text).toContain('Плитка керамическая');
    expect(screen.queryByTestId('open-materials')).not.toBeInTheDocument();
    // Вместо правки — статус передачи словом (ADR-155 §6).
    expect(text).toContain('Получено');
    expect(text).toContain('Ожидается');
  }, 20_000);
});
