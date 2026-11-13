import type { Meta, StoryObj } from '@storybook/react';
import { MoneyPanel } from './MoneyPanel';

const meta: Meta<typeof MoneyPanel> = {
  title: 'Компоненты/MoneyPanel',
  component: MoneyPanel,
};
export default meta;
type Story = StoryObj<typeof MoneyPanel>;

export const Contractor: Story = {
  args: {
    role: 'contractor',
    earnedLabel: 'Заработано за период',
    earned: { amount: '243000.00', currency: 'RUB' },
    donePct: 68,
    donePctLabel: '% выполнения',
    paidPct: 54,
    paidPctLabel: '% оплаты',
    receivedLabel: 'Получено',
    received: { amount: '131000.00', currency: 'RUB' },
    expectedLabel: 'Ожидается',
    expected: { amount: '112000.00', currency: 'RUB' },
  },
};

export const Customer: Story = {
  args: {
    role: 'customer',
    earnedLabel: 'Потрачено за период',
    earned: { amount: '312000.00', currency: 'RUB' },
    donePct: 40,
    donePctLabel: '% выполнения',
    paidPct: 62,
    paidPctLabel: '% оплаты',
    receivedLabel: 'Оплачено',
    received: { amount: '193000.00', currency: 'RUB' },
    expectedLabel: 'К оплате',
    expected: { amount: '119000.00', currency: 'RUB' },
  },
};
