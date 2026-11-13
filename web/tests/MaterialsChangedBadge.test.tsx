import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { createI18n } from '@porukam/i18n';
import { ContractDetailPage } from '../src/pages/ContractDetailPage';
import { useAuthStore } from '../src/features/auth/authStore';
import { useActorStore } from '../src/features/actor/actorStore';
import { createMaterial, markMaterialsSeen } from '../src/mocks/realContractsDb';

/**
 * Бейдж «Материалы изменены контрагентом» на карточке договора (фронтовой
 * хвост ADR-156) + строка правки материалов в ХРОНИКЕ ДОГОВОРА (ADR-157 §5).
 *
 * `rc-review-1` — на согласовании; Годвин (`pf-person-1`) там ЗАКАЗЧИК,
 * контрагент (`pf-mock-contractor-1`) — исполнитель. Правку материалов мок
 * публикует событием в хронику ровно как бэк, с ролью правящей стороны.
 *
 * Отметка «просмотрено» — СЕРВЕРНАЯ (ADR-158): мок держит её по стороне и
 * отдаёт в `contract.materials_seen_at` смотрящему, `localStorage` остался
 * оптимистичным кэшем. Поэтому «бейдж погас» проверяется и без него.
 */
const COUNTERPARTY = 'pf-mock-contractor-1';
const ME = 'pf-person-1';

function addMaterialAs(actingProfileId: string): void {
  createMaterial(
    'ms-1',
    {
      catalog_item_code: 'cat-tile',
      description: 'Плитка керамическая',
      source: 'customer',
      unit_price: '900.00',
      unit_price_currency: 'RUB',
      quantity: '10',
      unit: 'm2',
      delivery_days: 3,
      delivery_base: 'contract_signing',
    },
    actingProfileId,
  );
}

function renderCard() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <I18nextProvider i18n={createI18n('ru')}>
        <MemoryRouter initialEntries={['/contracts/rc-review-1']}>
          <Routes>
            <Route path="/contracts/:id" element={<ContractDetailPage />} />
            <Route path="/contracts/:id/stages/:sid" element={<div data-testid="stage-stub">stage</div>} />
          </Routes>
        </MemoryRouter>
      </I18nextProvider>
    </QueryClientProvider>,
  );
}

/**
 * Вкладки карточки сделки (замечание владельца 07.09): воронки и шита у
 * карточки больше нет — ВСЕ вкладки стоят в полосе (на телефоне в несколько
 * рядов), поэтому путь человека — прямой клик по вкладке.
 */
async function openCardTab(value: string): Promise<void> {
  await userEvent.click(await screen.findByTestId(`tab-${value}`));
}

describe('Карточка договора — «материалы изменены контрагентом»', () => {
  beforeEach(() => {
    localStorage.clear();
    useAuthStore.getState().setTokens({ access: 'a', refresh: 'r' });
    useActorStore.getState().reset();
    useActorStore.getState().setProfiles([
      { id: ME, kind: 'person', display_name: 'Годвин', handle: '@godwin', verification_level: 'basic', has_business_status: false },
    ]);
  });

  it('правка контрагента поднимает бейдж в «Обзоре», клик по нему ведёт к этапам и гасит бейдж', async () => {
    const user = userEvent.setup();
    addMaterialAs(COUNTERPARTY);
    renderCard();
    await screen.findByText('Сборка мебели — гостиная');

    const badge = await screen.findByTestId('materials-changed-badge');
    expect(badge).toHaveTextContent('Материалы изменены контрагентом');

    await user.click(badge);
    // Клик — это переход к материалам: открылись «Этапы», бейдж «Обзора» снят.
    expect(await screen.findByTestId('stage-materials')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByTestId('materials-changed-badge')).toBeNull());
    // Второй бейдж (адресный, на самом этапе) гаснет вместе с первым.
    expect(screen.queryByTestId('materials-changed-badge-stage')).toBeNull();
  }, 20_000);

  it('СВОЯ правка материалов бейджа не поднимает', async () => {
    addMaterialAs(ME);
    renderCard();
    await screen.findByText('Сборка мебели — гостиная');
    // Ждём готовности карточки, чтобы «нет бейджа» не означало «ещё грузится».
    expect(await screen.findByTestId('overview-propose-revision')).toBeInTheDocument();
    expect(screen.queryByTestId('materials-changed-badge')).toBeNull();
  }, 20_000);

  it('без правок материалов бейджа нет вовсе', async () => {
    renderCard();
    await screen.findByText('Сборка мебели — гостиная');
    expect(await screen.findByTestId('overview-propose-revision')).toBeInTheDocument();
    expect(screen.queryByTestId('materials-changed-badge')).toBeNull();
  }, 20_000);

  it('бейдж стоит на ТОМ этапе, чьи материалы правили', async () => {
    const user = userEvent.setup();
    addMaterialAs(COUNTERPARTY);
    renderCard();
    await screen.findByText('Сборка мебели — гостиная');

    await user.click(screen.getByRole('tab', { name: /Этапы/ }));
    const stageBadges = await screen.findAllByTestId('materials-changed-badge-stage');
    expect(stageBadges).toHaveLength(1);
    // Якорь ADR-156 §3 — ссылка уведомления ведёт на `#milestone-<id>`.
    expect(document.getElementById('milestone-ms-1')).toContainElement(stageBadges[0]!);

    await user.click(stageBadges[0]!);
    await waitFor(() => expect(screen.queryByTestId('materials-changed-badge-stage')).toBeNull());
  }, 20_000);

  it('серверная отметка гасит бейдж без локального кэша (смена устройства)', async () => {
    addMaterialAs(COUNTERPARTY);
    // Отметка стоит на СТОРОНЕ договора в моке — как `ContractParty.
    // materials_seen_at` на бэке; localStorage при этом пуст (beforeEach).
    markMaterialsSeen('rc-review-1', ME);
    renderCard();
    await screen.findByText('Сборка мебели — гостиная');

    expect(await screen.findByTestId('overview-propose-revision')).toBeInTheDocument();
    expect(screen.queryByTestId('materials-changed-badge')).toBeNull();
  }, 20_000);

  it('клик по бейджу отмечает просмотр НА СЕРВЕРЕ — после сброса кэша он не возвращается', async () => {
    const user = userEvent.setup();
    addMaterialAs(COUNTERPARTY);
    const view = renderCard();
    await screen.findByText('Сборка мебели — гостиная');

    await user.click(await screen.findByTestId('materials-changed-badge'));
    await waitFor(() => expect(screen.queryByTestId('materials-changed-badge')).toBeNull());

    // Имитируем другое устройство: локальный кэш пуст, карточка строится
    // заново — бейдж не должен подняться, отметку помнит мок-«бэк».
    view.unmount();
    localStorage.clear();
    renderCard();
    await screen.findByText('Сборка мебели — гостиная');
    expect(await screen.findByTestId('overview-propose-revision')).toBeInTheDocument();
    expect(screen.queryByTestId('materials-changed-badge')).toBeNull();
  }, 30_000);

  it('хроника договора показывает строку правки материалов', async () => {
    addMaterialAs(COUNTERPARTY);
    renderCard();
    await screen.findByText('Сборка мебели — гостиная');

    await openCardTab('timeline');
    const nested = await screen.findByTestId('timeline-nested');
    expect(nested).toHaveTextContent('Материал добавлен');
    expect(nested.querySelector('[data-kind="milestone.material_added"]')).not.toBeNull();
  }, 20_000);
});
