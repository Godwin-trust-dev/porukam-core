import type { Meta, StoryObj } from '@storybook/react';
import { PaymentPlan } from './PaymentPlan';

const meta: Meta<typeof PaymentPlan> = {
  title: 'Компоненты/PaymentPlan',
  component: PaymentPlan,
};
export default meta;
type Story = StoryObj<typeof PaymentPlan>;

export const Mixed: Story = {
  args: {
    paidLabel: 'Оплачено',
    dueLabel: 'К оплате',
    laterLabel: 'Позже',
    payLabel: 'Оплатить',
    onPay: () => {},
    rows: [
      { id: 'ms-1', stage: 'Демонтаж', note: 'Постоплата по приёмке', amount: { amount: '20000.00', currency: 'RUB' }, state: 'paid' },
      { id: 'ms-2', stage: 'Черновые работы', note: 'Этап принят — можно оплатить', amount: { amount: '50000.00', currency: 'RUB' }, state: 'due' },
      { id: 'ms-3', stage: 'Чистовая отделка', amount: { amount: '50000.00', currency: 'RUB' }, state: 'later' },
    ],
  },
};

export const WithoutPayAction: Story = {
  args: {
    ...Mixed.args,
    payLabel: undefined,
    onPay: undefined,
  },
};
