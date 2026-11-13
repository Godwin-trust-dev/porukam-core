import type { Meta, StoryObj } from '@storybook/react';
import { ContractRow } from './ContractRow';

const meta: Meta<typeof ContractRow> = {
  title: 'Компоненты/ContractRow',
  component: ContractRow,
};
export default meta;
type Story = StoryObj<typeof ContractRow>;

const base = {
  title: 'Ремонт ванной комнаты «под ключ»',
  counterparty: 'Мастер Ремонт (@masterremont)',
  progress: { done: 2, total: 5 },
  progressLabel: 'Этапы: 2 из 5',
  amount: { amount: '184000.00', currency: 'RUB' },
  onOpen: () => {},
};

export const Bank: Story = { args: { ...base, payment: 'bank', paymentLabel: 'Безналичный расчёт' } };
export const Sbp: Story = {
  args: { ...base, payment: 'sbp', paymentLabel: 'СБП', gate: 'Ждёт подписи', title: 'Поклейка обоев, две комнаты' },
};
export const Cash: Story = {
  args: { ...base, payment: 'cash', paymentLabel: 'Наличный расчёт', title: 'Сборка кухонного гарнитура' },
};

export const List: Story = {
  render: () => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <ContractRow {...base} payment="bank" paymentLabel="Безналичный расчёт" />
      <ContractRow
        {...base}
        payment="sbp"
        paymentLabel="СБП"
        gate="Ждёт подписи"
        title="Поклейка обоев, две комнаты"
      />
      <ContractRow {...base} payment="cash" paymentLabel="Наличный расчёт" title="Сборка кухонного гарнитура" />
    </div>
  ),
};
