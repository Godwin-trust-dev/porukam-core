import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  CashConfirm,
  PaymentBreakdown,
  PaymentMethodPicker,
  PaymentResult,
  PayoutGate,
  SbpPay,
} from '@porukam/ui';

describe('PaymentBreakdown (DEV-07 §2/§3) — раскладка до действия, без сумм тарифа', () => {
  it('показывает сумму и позицию платформы по комиссии, без литералов', () => {
    render(
      <PaymentBreakdown
        payingLabel="Вы переводите"
        amountLabel="45 000 ₽"
        transferTitle="Комиссия платформы — нет"
        transferNote="Комиссия за перевод не взимается платформой"
        positive
        caveat="Банк или платёжный провайдер может применить свой тариф"
      />,
    );
    expect(screen.getByText('45 000 ₽')).toBeInTheDocument();
    expect(screen.getByText('Комиссия платформы — нет')).toBeInTheDocument();
    expect(screen.getByText(/тариф/)).toBeInTheDocument();
  });
});

describe('PaymentMethodPicker (DEV-07 §2/§3) — способы из paymentPolicy.methods', () => {
  it('один способ → без переключателя', () => {
    render(<PaymentMethodPicker methods={[{ kind: 'cash', label: 'Наличные' }]} selected="cash" onSelect={() => {}} />);
    expect(screen.getByTestId('payment-method-single')).toBeInTheDocument();
    expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument();
  });

  it('два способа → переключатель, клик вызывает onSelect', async () => {
    const onSelect = vi.fn();
    render(
      <PaymentMethodPicker
        methods={[
          { kind: 'cash', label: 'Наличные' },
          { kind: 'sbp', label: 'СБП' },
        ]}
        selected="cash"
        onSelect={onSelect}
      />,
    );
    expect(screen.getByRole('radiogroup')).toBeInTheDocument();
    await userEvent.click(screen.getByTestId('payment-method-sbp'));
    expect(onSelect).toHaveBeenCalledWith('sbp');
  });
});

describe('SbpPay (DEV-07 §2/§3) — статус авто, без кнопки подтверждения', () => {
  it('pending: показывает статус, банки, без кнопки подтверждения', () => {
    render(
      <SbpPay
        amountLabel="45 000 ₽"
        banks={['Т-Банк', 'Сбербанк']}
        status="pending"
        qrHint="QR-код для оплаты через СБП"
        banksLabel="Или откройте приложение банка"
        statusLabel="Ожидаем подтверждение банка"
      />,
    );
    expect(screen.getByText('Ожидаем подтверждение банка')).toBeInTheDocument();
    expect(screen.getByText('Т-Банк')).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});

describe('CashConfirm (DEV-07 §2/§3) — двустороннее подтверждение, без «Отменить»', () => {
  const LABELS = {
    payerLabel: 'Заказчик',
    payeeLabel: 'Исполнитель',
    confirmedLabel: 'Подтвердил(а)',
    waitingLabel: 'Ждём подтверждения',
    confirmLabel: 'Подтверждаю получение',
    disputeLabel: 'Что-то не так?',
  };

  it('получателю в ожидании — кнопка подтверждения видна, вызывает onConfirm', async () => {
    const onConfirm = vi.fn();
    render(
      <CashConfirm
        {...LABELS}
        payer={{ name: 'Годвин', confirmed: true, at: '2 авг' }}
        payee={{ name: 'Мастер Ремонт', confirmed: false }}
        viewerIsPayee
        onConfirm={onConfirm}
        onDispute={() => {}}
      />,
    );
    await userEvent.click(screen.getByTestId('confirm-receipt'));
    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it('плательщику — кнопки подтверждения нет; кнопки «Отменить» нет нигде', () => {
    render(
      <CashConfirm
        {...LABELS}
        payer={{ name: 'Годвин', confirmed: true, at: '2 авг' }}
        payee={{ name: 'Мастер Ремонт', confirmed: false }}
        viewerIsPayee={false}
        onConfirm={() => {}}
        onDispute={() => {}}
      />,
    );
    expect(screen.queryByTestId('confirm-receipt')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Отменить/i })).not.toBeInTheDocument();
  });

  it('получателю, уже подтвердившему, — кнопки подтверждения больше нет', () => {
    render(
      <CashConfirm
        {...LABELS}
        payer={{ name: 'Годвин', confirmed: true, at: '2 авг' }}
        payee={{ name: 'Мастер Ремонт', confirmed: true, at: '2 авг' }}
        viewerIsPayee
        onConfirm={() => {}}
        onDispute={() => {}}
      />,
    );
    expect(screen.queryByTestId('confirm-receipt')).not.toBeInTheDocument();
  });

  it('ссылка спора вызывает onDispute', async () => {
    const onDispute = vi.fn();
    render(
      <CashConfirm
        {...LABELS}
        payer={{ name: 'Годвин', confirmed: true, at: '2 авг' }}
        payee={{ name: 'Мастер Ремонт', confirmed: false }}
        viewerIsPayee={false}
        onConfirm={() => {}}
        onDispute={onDispute}
      />,
    );
    await userEvent.click(screen.getByTestId('dispute-link'));
    expect(onDispute).toHaveBeenCalledOnce();
  });
});

describe('PaymentResult (DEV-07 §2/§3) — без искры', () => {
  it('succeeded: показывает чип и кнопку «Готово»', async () => {
    const onDone = vi.fn();
    render(
      <PaymentResult
        state="succeeded"
        title="Переведено"
        summaryChip="45 000 ₽ · СБП · 14:32"
        doneLabel="Готово"
        onDone={onDone}
      />,
    );
    expect(screen.getByText('45 000 ₽ · СБП · 14:32')).toBeInTheDocument();
    expect(screen.queryByRole('img', { name: /Готово|Переведено/ })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Готово' }));
    expect(onDone).toHaveBeenCalledOnce();
  });

  it('failed: показывает ошибку и кнопку «Повторить»', async () => {
    const onRetry = vi.fn();
    render(
      <PaymentResult
        state="failed"
        title="Платёж не прошёл"
        errorText="Банк отклонил операцию"
        retryLabel="Повторить"
        onRetry={onRetry}
      />,
    );
    expect(screen.getByText('Банк отклонил операцию')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Повторить' }));
    expect(onRetry).toHaveBeenCalledOnce();
  });
});

describe('PayoutGate (DEV-07 §3)', () => {
  it('required=false → ничего не рендерит', () => {
    render(<PayoutGate required={false} title="t" text="x" ctaLabel="Добавить" onSetup={() => {}} />);
    expect(screen.queryByTestId('payout-gate')).not.toBeInTheDocument();
  });

  it('required=true → показывает гейт, кнопка вызывает onSetup', async () => {
    const onSetup = vi.fn();
    render(<PayoutGate required title="Нужны реквизиты" text="Добавьте реквизиты" ctaLabel="Добавить" onSetup={onSetup} />);
    expect(screen.getByTestId('payout-gate')).toBeInTheDocument();
    await userEvent.click(screen.getByTestId('payout-gate-setup'));
    expect(onSetup).toHaveBeenCalledOnce();
  });
});
