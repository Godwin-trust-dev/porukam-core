import type { Meta, StoryObj } from '@storybook/react';
import { ContractHeader } from './ContractHeader';

const meta: Meta<typeof ContractHeader> = {
  title: 'Компоненты/ContractHeader',
  component: ContractHeader,
};
export default meta;
type Story = StoryObj<typeof ContractHeader>;

export const InProgress: Story = {
  args: {
    title: 'Ремонт кухни «под ключ»',
    no: '№ Д-3005',
    counterparty: { name: 'Мастер Ремонт', onOpen: () => {} },
    viewerRoleLabel: 'Вы — заказчик',
    status: 'in_progress',
    statusLabel: 'В работе',
    stageCaption: 'этап 2 из 3',
    sum: { amount: '120000.00', currency: 'RUB' },
    paymentMethodLabel: 'Безналичный расчёт',
    version: { short: '9f3a2c1e…', onOpen: () => {} },
    versionLabel: 'Версия',
  },
};

export const Suspended: Story = {
  args: {
    ...InProgress.args,
    status: 'suspended',
    statusLabel: 'Приостановлен',
  },
};
