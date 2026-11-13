import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { createI18n } from '@porukam/i18n';
import { http, HttpResponse } from 'msw';
import { server } from '../src/mocks/server';
import { StagePage } from '../src/pages/StagePage';
import { useAuthStore } from '../src/features/auth/authStore';
import { useActorStore } from '../src/features/actor/actorStore';
import { confirmRealPayment, gateStatus, listContractPayments, listMaterials } from '../src/mocks/realContractsDb';

/**
 * Гейт старта этапа и передача материалов (ADR-155, решения владельца 03.09).
 *
 * Проверяем ровно то, что было решено словами: до подписания все три условия
 * «Ждём»; при предоплате финансовое условие называется оплатой этапа; «Начать
 * этап» ходит по `can_start`, а 409 говорит ПРИЧИНОЙ, а не кодом; «получено»
 * ставится односторонне и после него кнопок не остаётся.
 */
function renderStage(path: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const i18n = createI18n('ru');
  return render(
    <QueryClientProvider client={qc}>
      <I18nextProvider i18n={i18n}>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="/contracts/:id/stages/:sid" element={<StagePage />} />
            <Route path="/contracts/:id" element={<div>card-stub</div>} />
          </Routes>
        </MemoryRouter>
      </I18nextProvider>
    </QueryClientProvider>,
  );
}

function actAs(profileId: string, name: string): void {
  useActorStore.getState().reset();
  useActorStore.getState().setProfiles([
    { id: profileId, kind: 'person', display_name: name, handle: `@${profileId}`, verification_level: 'basic', has_business_status: false },
  ]);
}

beforeEach(() => {
  useAuthStore.getState().setTokens({ access: 'a', refresh: 'r' });
  useActorStore.getState().reset();
});

describe('Гейт старта этапа — три состояния условий (ADR-155 §5)', () => {
  it('договор не подписан → все три условия «Ждём» (владелец 03.09)', async () => {
    actAs('pf-person-1', 'Годвин');
    renderStage('/contracts/rc-review-1/stages/ms-1');

    const gate = within(await screen.findByTestId('start-conditions'));
    const states = gate.getAllByTestId('start-condition-state');
    expect(states).toHaveLength(3);
    expect(states.map((s) => s.textContent)).toEqual(['Ждём', 'Ждём', 'Ждём']);
    // Ни «Готово», ни «Не требуется» до подписи не рисуем: обязательства ещё
    // не возникли, а «Готово» там, где договора нет, вводит в заблуждение.
    expect(gate.queryByText('Готово')).not.toBeInTheDocument();
    expect(gate.queryByText('Не требуется')).not.toBeInTheDocument();
  });

  it('подписан, наличные, без материалов → «Готово» + два «Не требуется», старт доступен', async () => {
    actAs('pf-person-1', 'Годвин');
    renderStage('/contracts/rc-signed-cash-1/stages/ms-cash-1');

    const gate = within(await screen.findByTestId('start-conditions'));
    await waitFor(() => expect(gate.getAllByTestId('start-condition-state').map((s) => s.textContent)).toEqual(['Готово', 'Не требуется', 'Не требуется']));
    await waitFor(() => expect(screen.getByTestId('start-stage-cta')).toBeEnabled());
  });

  it('предоплата: финансовое условие названо оплатой этапа и стоит в «Ждём», кнопки старта нет вовсе', async () => {
    actAs('pf-mock-contractor-1', 'Марат Отделкин');
    renderStage('/contracts/rc-prepay-1/stages/ms-prepay-1');

    const gate = within(await screen.findByTestId('start-conditions'));
    expect(await gate.findByText('Оплата этапа заказчиком')).toBeInTheDocument();
    expect(gate.queryByText('Финансовое условие')).not.toBeInTheDocument();
    await waitFor(() => expect(gate.getAllByTestId('start-condition-state').map((s) => s.textContent)).toEqual(['Готово', 'Ждём', 'Ждём']));
    expect(await screen.findByText('Ждём подтверждения оплаты обеими сторонами')).toBeInTheDocument();
    // ADR-162: пока условие «Ждём», старт не «заблокированная кнопка», а
    // обещание — нажимать человеку нечего.
    expect(await screen.findByTestId('auto-start-note')).toHaveTextContent('Этап начнётся автоматически');
    expect(screen.queryByTestId('start-stage-cta')).not.toBeInTheDocument();
  });

  it('ADR-162: последнее условие закрывается на экране → этап стартует сам, без нажатия', async () => {
    // Предоплата уже подтверждена обеими сторонами — незакрытым остаётся
    // РОВНО одно условие, материал заказчика. Его отметка «получено» и есть
    // последнее подтверждение: кнопку «Начать этап» никто не нажимает.
    const { items } = listContractPayments('rc-prepay-1', 'pf-person-1');
    confirmRealPayment(items[0]!.id, undefined, 'pf-person-1');
    confirmRealPayment(items[0]!.id, undefined, 'pf-mock-contractor-1');
    actAs('pf-mock-contractor-1', 'Марат Отделкин'); // исполнитель — он отмечает получение

    renderStage('/contracts/rc-prepay-1/stages/ms-prepay-1');

    expect(await screen.findByTestId('auto-start-note')).toBeInTheDocument();
    const row = within(await screen.findByTestId('stage-material-row'));
    await userEvent.click(row.getByTestId('material-received'));

    expect(await screen.findByText('В работе')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByTestId('auto-start-note')).not.toBeInTheDocument());
    expect(screen.queryByTestId('start-stage-cta')).not.toBeInTheDocument();
  });

  it('409 на старте объясняется причиной из context.reason, а не кодом ошибки', async () => {
    actAs('pf-person-1', 'Годвин');
    server.use(
      http.post('/v1/milestones/:milestoneId/start', () =>
        HttpResponse.json(
          {
            status: 409,
            code: 'gate_financial_condition_not_met',
            title: 'gate_financial_condition_not_met',
            detail: 'финансовое условие не выполнено',
            context: { reason: 'payment_not_confirmed' },
          },
          { status: 409, headers: { 'Content-Type': 'application/problem+json' } },
        ),
      ),
    );
    renderStage('/contracts/rc-signed-cash-1/stages/ms-cash-1');
    const cta = await screen.findByTestId('start-stage-cta');
    await waitFor(() => expect(cta).toBeEnabled());

    await userEvent.click(cta);

    expect(await screen.findByText('Ждём подтверждения оплаты обеими сторонами')).toBeInTheDocument();
  });
});

describe('Материалы этапа — двустороннее подтверждение (ADR-155 §6)', () => {
  it('заказчик отмечает «Материалы переданы»; кнопки исполнителя у него нет', async () => {
    actAs('pf-person-1', 'Годвин'); // заказчик rc-prepay-1
    renderStage('/contracts/rc-prepay-1/stages/ms-prepay-1');

    const row = within(await screen.findByTestId('stage-material-row'));
    expect(row.getByTestId('material-state')).toHaveTextContent('Ожидается');
    expect(row.queryByTestId('material-received')).not.toBeInTheDocument();

    await userEvent.click(row.getByTestId('material-handed-over'));

    await waitFor(() => expect(listMaterials('ms-prepay-1')[0]!.handed_over_at).not.toBeNull());
    expect(await screen.findByText(/^Передано · /)).toBeInTheDocument();
    // «Передано» гейт не двигает: факт заявлен одной стороной.
    expect(gateStatus('ms-prepay-1').conditions.materials).toBe('waiting');
  });

  it('исполнитель ставит «Материалы получены» БЕЗ «передано» — гейт двигается, кнопок больше нет', async () => {
    actAs('pf-mock-contractor-1', 'Марат Отделкин'); // исполнитель rc-prepay-1
    renderStage('/contracts/rc-prepay-1/stages/ms-prepay-1');

    const row = within(await screen.findByTestId('stage-material-row'));
    expect(row.queryByTestId('material-handed-over')).not.toBeInTheDocument();
    await userEvent.click(row.getByTestId('material-received'));

    await waitFor(() => expect(listMaterials('ms-prepay-1')[0]!.received).toBe(true));
    expect(gateStatus('ms-prepay-1').conditions.materials).toBe('met');
    await waitFor(() => expect(screen.queryByTestId('material-received')).not.toBeInTheDocument());
    expect(screen.queryByTestId('material-handed-over')).not.toBeInTheDocument();
    expect(await screen.findByText(/^Получено · /)).toBeInTheDocument();
  });

  it('материал исполнителя — без подтверждений, только пометка «поставляет исполнитель»', async () => {
    actAs('pf-person-1', 'Годвин');
    server.use(
      http.get('/v1/milestones/ms-prepay-1/materials', () =>
        HttpResponse.json([
          {
            ...listMaterials('ms-prepay-1')[0]!,
            id: 'mat-contractor-1',
            description: 'Клей монтажный',
            source: 'contractor',
            unit_price: '450.00',
          },
        ]),
      ),
    );
    renderStage('/contracts/rc-prepay-1/stages/ms-prepay-1');

    const row = within(await screen.findByTestId('stage-material-row'));
    expect(row.getByTestId('material-state')).toHaveTextContent('Поставляет исполнитель');
    expect(row.queryByTestId('material-handed-over')).not.toBeInTheDocument();
    expect(row.queryByTestId('material-received')).not.toBeInTheDocument();
  });
});

describe('Предоплата в оплатах (ADR-151/155 §2–3)', () => {
  it('счёт по листу выставлен с подписания, до всякой приёмки', () => {
    const { items } = listContractPayments('rc-prepay-1', 'pf-person-1');
    expect(items).toHaveLength(1);
    expect(items[0]!.milestone_id).toBe('ms-prepay-1');
    expect(items[0]!.kind).toBe('postpayment'); // вид один — срок несёт payment_order
    expect(items[0]!.status).toBe('pending');
  });

  it('оба подтверждения открывают гейт, но лист остаётся не оплаченным до приёмки', () => {
    const { items } = listContractPayments('rc-prepay-1', 'pf-person-1');
    confirmRealPayment(items[0]!.id, undefined, 'pf-person-1');
    expect(gateStatus('ms-prepay-1').conditions.financial).toBe('waiting');

    confirmRealPayment(items[0]!.id, undefined, 'pf-mock-contractor-1');
    expect(gateStatus('ms-prepay-1').conditions.financial).toBe('met');
    // `paid` наступает в момент приёмки, а не подтверждения оплаты (§3).
    expect(listContractPayments('rc-prepay-1', 'pf-person-1').items[0]!.status).toBe('confirmed');
  });

  it('строка счёта при предоплате подписана сроком, после оплаты — «этап можно начать»', async () => {
    const { items } = listContractPayments('rc-prepay-1', 'pf-person-1');
    confirmRealPayment(items[0]!.id, undefined, 'pf-person-1');
    confirmRealPayment(items[0]!.id, undefined, 'pf-mock-contractor-1');

    actAs('pf-person-1', 'Годвин');
    renderStage('/contracts/rc-prepay-1/stages/ms-prepay-1');

    const card = within(await screen.findByTestId('stage-payment-confirm'));
    expect(await card.findByText('Оплачено, этап можно начать')).toBeInTheDocument();
    expect(card.getByText(/оплата до начала этапа/)).toBeInTheDocument();
  });
});
