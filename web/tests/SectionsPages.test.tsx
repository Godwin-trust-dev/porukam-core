import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { createI18n } from '@porukam/i18n';
import { StagesPage } from '../src/pages/StagesPage';
import { PaymentsPage } from '../src/pages/PaymentsPage';
import { DisputesPage } from '../src/pages/DisputesPage';
import { useAuthStore } from '../src/features/auth/authStore';
import { useActorStore } from '../src/features/actor/actorStore';
import { resetProfilesDb, setProfileAvatar } from '../src/mocks/profilesDb';

/** Контрагент сидов разделов и споров — «Марат Отделкин» (profilesDb). */
const COUNTERPARTY = 'pf-mock-contractor-1';

/**
 * Разделы /stages, /payments, /disputes (отсмотр 2026-08-22, ADR-109) —
 * happy-path поверх MSW-агрегатов `realContractsDb` (сиды: подписанный
 * rc-progress-1 с листьями разных статусов у актёра pf-person-1).
 */

function renderAt(path: string, element: JSX.Element) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <I18nextProvider i18n={createI18n('ru')}>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path={path} element={element} />
            <Route path="/contracts/:id" element={<div data-testid="contract-page" />} />
          </Routes>
        </MemoryRouter>
      </I18nextProvider>
    </QueryClientProvider>,
  );
}

describe('Разделы этапов, платежей и споров', () => {
  beforeEach(() => {
    useAuthStore.getState().setTokens({ access: 'a', refresh: 'r' });
    useActorStore.setState({ activeProfileId: 'pf-person-1' });
  });

  // Фото живёт в общем profilesDb — сбрасываем, чтобы соседние тесты видели
  // сид без картинок.
  afterEach(() => {
    resetProfilesDb();
  });

  it('/stages: листья подписанных договоров со статусами и суммами', async () => {
    renderAt('/stages', <StagesPage />);
    const list = await screen.findByTestId('stages-list');
    expect(within(list).getByText('Плитка')).toBeInTheDocument();
    expect(within(list).getAllByText('В работе').length).toBeGreaterThan(0);
    expect(within(list).getAllByText('На приёмке').length).toBeGreaterThan(0);
    // Договор и контрагент — в мете строки.
    expect(within(list).getAllByText('Ремонт ванной комнаты').length).toBeGreaterThan(0);
    // Имя контрагента — из profilesDb (единый источник, что и GET /profiles/{id}
    // в карточке договора). Раньше в realContractsDb лежала своя копия-константа
    // с другим именем — разделы и карточка расходились (хвосты 2026-08-25).
    expect(within(list).getAllByText(/Марат Отделкин/).length).toBeGreaterThan(0);
  });

  it('/payments: группы «предстоят»/«ждут подтверждения»/«оплачены» с итогами по валютам', async () => {
    renderAt('/payments', <PaymentsPage />);
    const groups = await screen.findByTestId('payments-groups');
    // Сид rc-paying-1 (`cash`, отсмотр 2026-08-25) закрывает все три группы:
    // ms-pay-1 accepted → «Ждут подтверждения», ms-pay-2 paid → «Оплачены»,
    // ms-3/ms-pay-3 in_progress → «Предстоят».
    // Подпись группы — заголовок раздела (`SectionLabel`).
    expect(within(groups).getByRole('heading', { name: 'Ждут подтверждения' })).toBeInTheDocument();
    expect(within(groups).getByRole('heading', { name: 'Предстоят' })).toBeInTheDocument();
    expect(within(groups).getByRole('heading', { name: 'Оплачены' })).toBeInTheDocument();
    // Итог по валютам — свой у каждой группы.
    expect(within(groups).getAllByText(/Итого:/)).toHaveLength(3);
  });

  // Решение владельца 05.09: состояние платежа несёт ТОЛЬКО подпись группы.
  // Слово-статус в строке было буквальным дублем этой подписи и на 360px
  // отъедало ширину у имени контрагента (`ListRow .status` не сжимается).
  it('/payments: состояние платежа — только подпись группы, в строках дубля нет', async () => {
    renderAt('/payments', <PaymentsPage />);
    const groups = await screen.findByTestId('payments-groups');
    for (const label of ['Ждут подтверждения', 'Предстоят', 'Оплачены']) {
      expect(within(groups).getAllByText(label)).toHaveLength(1);
      expect(within(groups).getByText(label).tagName).toMatch(/^H[23]$/);
    }
    // Группировка при этом остаётся озвученной вспомогательным технологиям —
    // у секции есть `aria-label` с тем же словом.
    expect(within(groups).getByLabelText('Ждут подтверждения')).toBeInTheDocument();
  });

  // Раздел «Разногласия» с этапа 7 (ADR-131) живёт своим контуром — вкладки,
  // контрагент из ответа, карточка спора; подробности в DisputePage.test.tsx,
  // здесь остаётся только проверка, что раздел вообще рисуется рядом с двумя
  // соседними агрегатами.
  it('/disputes: открытое и закрытое разногласия в списке', async () => {
    renderAt('/disputes', <DisputesPage />);
    const list = await screen.findByTestId('disputes-list');
    expect(within(list).getAllByText('Открыто').length).toBeGreaterThan(0);
    expect(within(list).getAllByText('Закрыто').length).toBeGreaterThan(0);
  });

  // ADR-173 (владелец 08.09): «фото контрагента напротив договора» — и в
  // разделах. Агрегаты бэка несут `avatar_url` рядом с `display_name`;
  // null (фото нет либо deals_only) оставляет инициалы, как было.
  it('/payments: фото контрагента рисуется картинкой, без фото — инициалы', async () => {
    const initials = renderAt('/payments', <PaymentsPage />);
    const groups = await screen.findByTestId('payments-groups');
    expect(groups.querySelector('img')).toBeNull();
    initials.unmount();

    setProfileAvatar(COUNTERPARTY, new Uint8Array([1, 2, 3]), 'image/png');
    renderAt('/payments', <PaymentsPage />);
    const withPhoto = await screen.findByTestId('payments-groups');
    const img = withPhoto.querySelector('img');
    expect(img).not.toBeNull();
    expect(img!.getAttribute('src')).toContain(`/v1/profiles/${COUNTERPARTY}/avatar`);
  });

  it('/disputes: фото контрагента рисуется картинкой, без фото — инициалы', async () => {
    const initials = renderAt('/disputes', <DisputesPage />);
    expect((await screen.findByTestId('disputes-list')).querySelector('img')).toBeNull();
    initials.unmount();

    setProfileAvatar(COUNTERPARTY, new Uint8Array([1, 2, 3]), 'image/png');
    renderAt('/disputes', <DisputesPage />);
    const list = await screen.findByTestId('disputes-list');
    expect(list.querySelector('img')?.getAttribute('src')).toContain(
      `/v1/profiles/${COUNTERPARTY}/avatar`,
    );
  });
});
