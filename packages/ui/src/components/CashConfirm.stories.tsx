import type { Meta, StoryObj } from '@storybook/react';
import { CashConfirm } from './CashConfirm';

const meta: Meta<typeof CashConfirm> = {
  title: 'Компоненты/CashConfirm',
  component: CashConfirm,
};
export default meta;
type Story = StoryObj<typeof CashConfirm>;

const LABELS = {
  payerLabel: 'Заказчик',
  payeeLabel: 'Исполнитель',
  confirmedLabel: 'Подтвердил',
  waitingLabel: 'Ждём подтверждения',
  confirmLabel: 'Подтверждаю получение',
  disputeLabel: 'Что-то не так?',
  onConfirm: () => {},
  onDispute: () => {},
};

export const PayerConfirmedWaitingPayee: Story = {
  args: {
    ...LABELS,
    payer: { name: 'Годвин', confirmed: true, at: '2 авг, 10:14' },
    payee: { name: 'Мастер Ремонт', confirmed: false },
    viewerIsPayee: false,
  },
};

export const PayeeCanConfirm: Story = {
  args: {
    ...LABELS,
    payer: { name: 'Годвин', confirmed: true, at: '2 авг, 10:14' },
    payee: { name: 'Мастер Ремонт', confirmed: false },
    viewerIsPayee: true,
  },
};

export const BothConfirmed: Story = {
  args: {
    ...LABELS,
    payer: { name: 'Годвин', confirmed: true, at: '2 авг, 10:14' },
    payee: { name: 'Мастер Ремонт', confirmed: true, at: '2 авг, 11:02' },
    viewerIsPayee: false,
  },
};
