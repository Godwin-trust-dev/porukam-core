import type { Meta, StoryObj } from '@storybook/react';
import { PaymentPolicyLine } from './PaymentPolicyLine';

const meta: Meta<typeof PaymentPolicyLine> = {
  title: 'Компоненты/PaymentPolicyLine',
  component: PaymentPolicyLine,
};
export default meta;
type Story = StoryObj<typeof PaymentPolicyLine>;

export const Free: Story = {
  args: {
    title: 'Платежи — без комиссии',
    note: 'Комиссия за перевод не взимается платформой',
    positive: true,
  },
};

export const Paid: Story = {
  args: {
    title: 'Платежи — с комиссией за перевод',
    note: 'Тариф оператора списывается с плательщика',
    positive: false,
  },
};
