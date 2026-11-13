import type { Meta, StoryObj } from '@storybook/react';
import { PaymentBreakdown } from './PaymentBreakdown';

const meta: Meta<typeof PaymentBreakdown> = {
  title: 'Компоненты/PaymentBreakdown',
  component: PaymentBreakdown,
};
export default meta;
type Story = StoryObj<typeof PaymentBreakdown>;

export const NoCommission: Story = {
  args: {
    payingLabel: 'Вы переводите',
    amountLabel: '45 000 ₽',
    transferTitle: 'Комиссия платформы — нет',
    transferNote: 'Комиссия за перевод не взимается платформой',
    positive: true,
    caveat: 'Банк или платёжный провайдер может применить свой тариф',
  },
};

export const WithCommission: Story = {
  args: {
    ...NoCommission.args,
    transferTitle: 'Платежи — с комиссией за перевод',
    transferNote: 'Тариф оператора списывается с плательщика',
    positive: false,
  },
};
