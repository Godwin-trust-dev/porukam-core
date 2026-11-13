import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { createI18n } from '@porukam/i18n';
import { PaymentPage } from '../src/pages/PaymentPage';
import { useAuthStore } from '../src/features/auth/authStore';
import { useActorStore } from '../src/features/actor/actorStore';
import { useViewerStore } from '../src/features/contracts/viewerStore';

function renderPage(path: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const i18n = createI18n('ru');
  return render(
    <QueryClientProvider client={qc}>
      <I18nextProvider i18n={i18n}>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="/contracts/:id/payments/:pid" element={<PaymentPage />} />
            <Route path="/contracts/:id/money" element={<div>вкладка «Деньги»</div>} />
          </Routes>
        </MemoryRouter>
      </I18nextProvider>
    </QueryClientProvider>,
  );
}

describe('PaymentPage (DEV-07) — приёмка §9', () => {
  beforeEach(() => {
    useAuthStore.getState().setTokens({ access: 'a', refresh: 'r' });
    useActorStore.getState().reset();
    useActorStore.getState().setProfiles([
      {
        id: 'pf-viewer',
        kind: 'person',
        display_name: 'Смотрящий',
        handle: '@viewer',
        verification_level: 'basic',
        has_business_status: false,
      },
    ]);
    useViewerStore.getState().setViewAs('customer');
  });

  it('заказчик: план → «Оплатить» → раскладка (без сумм тарифа) → выбор способа → создание платежа → СБП pending (приёмка 1)', async () => {
    const { db } = await import('../src/mocks/contractsDb');
    const stage = db.get('c-5001').milestones.find((m) => m.status === 'accepted')!;

    renderPage(`/contracts/c-5001/payments/new?stage=${stage.id}`);

    expect(await screen.findByTestId('payment-hero')).toBeInTheDocument();
    expect(screen.getByText('Платежи — без комиссии')).toBeInTheDocument();
    expect(screen.getByTestId('payment-method-picker')).toBeInTheDocument();

    await userEvent.click(screen.getByTestId('payment-method-sbp'));
    await userEvent.click(screen.getByTestId('pay-submit'));

    expect(await screen.findByTestId('sbp-pay')).toBeInTheDocument();
    expect(screen.getByText('Ожидаем подтверждение банка')).toBeInTheDocument();
  });

  it('наличные: получателю доступно «Подтверждаю получение», этап оплачен после подтверждения (приёмка 2)', async () => {
    useViewerStore.getState().setViewAs('contractor');
    renderPage('/contracts/c-5002/payments/pay-cash-demo');

    expect(await screen.findByTestId('cash-confirm')).toBeInTheDocument();
    await userEvent.click(screen.getByTestId('confirm-receipt'));

    expect(await screen.findByTestId('payment-result')).toBeInTheDocument();
    expect(screen.getByText('Переведено')).toBeInTheDocument();
  });

  it('шапка существующего платежа: этап, договор ссылкой на карточку, сумма с валютой (мобильный проход 25.08)', async () => {
    const { db } = await import('../src/mocks/contractsDb');
    const { paymentsDb } = await import('../src/mocks/paymentsDb');
    const c = db.get('c-5002');
    const payment = paymentsDb.get('pay-cash-demo');
    const stage = c.milestones.find((m) => m.id === payment.stage_id)!;

    renderPage('/contracts/c-5002/payments/pay-cash-demo');
    await screen.findByTestId('cash-confirm');

    const head = screen.getByTestId('payment-head');
    expect(head).toHaveTextContent(stage.title);
    expect(screen.getByTestId('payment-head-contract')).toHaveAttribute('href', '/contracts/c-5002');
    expect(screen.getByTestId('payment-head-contract')).toHaveTextContent(c.title);
    // Сумма — пара amount+currency, отформатированная (не «сырое» число без валюты).
    expect(screen.getByTestId('payment-head-amount')).toHaveTextContent('₽');
  });

  it('нигде нет кнопки «Отменить отметку» (приёмка 3)', async () => {
    renderPage('/contracts/c-5002/payments/pay-cash-demo');
    await screen.findByTestId('cash-confirm');
    expect(screen.queryByRole('button', { name: /Отменить/i })).not.toBeInTheDocument();
  });

  it('ошибка → «Что-то не так?» ведёт в спор без отката отметок (приёмка 3)', async () => {
    renderPage('/contracts/c-5002/payments/pay-cash-demo');
    await screen.findByTestId('cash-confirm');
    await userEvent.click(screen.getByTestId('dispute-link'));
    expect(await screen.findByText(/Передали в спор/)).toBeInTheDocument();
  });

  it('получатель видит «Переведено» после подтверждения — не «поступит» (приёмка 4)', async () => {
    useViewerStore.getState().setViewAs('contractor');
    renderPage('/contracts/c-5002/payments/pay-cash-demo');

    // До подтверждения — нигде на экране получателя нет «поступит».
    await screen.findByTestId('cash-confirm');
    expect(screen.queryByText(/поступит/)).not.toBeInTheDocument();

    await userEvent.click(screen.getByTestId('confirm-receipt'));
    expect(await screen.findByText('Переведено')).toBeInTheDocument();
    expect(screen.queryByText(/поступит/)).not.toBeInTheDocument();
  });

  it('политика без онлайн-провайдера → только наличные, переключателя нет (приёмка 5)', async () => {
    const { db } = await import('../src/mocks/contractsDb');
    const stage = db.get('c-5005').milestones.find((m) => m.status === 'accepted')!;
    renderPage(`/contracts/c-5005/payments/new?stage=${stage.id}`);

    expect(await screen.findByTestId('payment-method-single')).toBeInTheDocument();
    expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument();
    expect(screen.queryByTestId('payment-method-sbp')).not.toBeInTheDocument();
  });

  it('failed → «Повторить» ведёт обратно на выбор способа для того же этапа', async () => {
    renderPage('/contracts/c-5002/payments/pay-failed-demo');
    expect(await screen.findByText('Платёж не прошёл')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Повторить' }));
    expect(await screen.findByTestId('payment-hero')).toBeInTheDocument();
  });
});
