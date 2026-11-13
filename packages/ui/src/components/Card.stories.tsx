import type { Meta, StoryObj } from '@storybook/react';
import type { ContractSummary } from '@porukam/core';
import { Card, ContractCard } from './Card';

const base: ContractSummary = {
  id: 'c1',
  title: 'Ремонт ванной комнаты «под ключ»',
  status: 'active',
  segment: 'paid_business',
  sphere: 'Ремонт',
  my_role: 'customer',
  parties: [
    { profile_id: 'p1', display_name: 'Я', handle: '@me', role: 'customer' },
    { profile_id: 'p2', display_name: 'Мастер Ремонт', handle: '@masterremont', role: 'contractor' },
  ],
  total: { amount: '184000.00', currency: 'RUB' },
  payment_protected: true,
  milestones_total: 5,
  milestones_accepted: 2,
  updated_at: '2026-07-20T10:00:00Z',
  acceptance_deadline: null,
};

const meta: Meta<typeof ContractCard> = {
  title: 'Компоненты/ContractCard',
  component: ContractCard,
};
export default meta;
type Story = StoryObj<typeof ContractCard>;

export const Active: Story = {
  args: {
    contract: base,
    statusLabel: 'В работе',
    segmentLabel: 'С бизнесом',
    roleLabel: 'Заказчик',
    protectionLabel: 'Платёж под защитой',
    milestonesLabel: 'Этапы: 2 из 5',
  },
};

export const UnderAcceptance: Story = {
  args: {
    contract: { ...base, status: 'under_acceptance', acceptance_deadline: '2026-07-24T10:00:00Z' },
    statusLabel: 'Ждёт приёмки',
    segmentLabel: 'С бизнесом',
    roleLabel: 'Заказчик',
    protectionLabel: 'Платёж под защитой',
    milestonesLabel: 'Этапы: 3 из 5',
    acceptanceLabel: 'осталось 6 ч',
  },
};

export const FreeC2C: Story = {
  args: {
    contract: {
      ...base,
      title: 'Собрать шкаф',
      segment: 'free_c2c',
      payment_protected: false,
      total: { amount: '3000.00', currency: 'RUB' },
    },
    statusLabel: 'В работе',
    segmentLabel: 'Между людьми',
    roleLabel: 'Исполнитель',
    protectionLabel: 'Без защиты платежа',
    milestonesLabel: 'Этапы: 0 из 1',
  },
};

export const Basic: StoryObj = {
  render: () => (
    <Card style={{ maxWidth: 360 }}>
      <p style={{ margin: 0 }}>Базовая карточка — контейнер для любого содержимого.</p>
    </Card>
  ),
};
