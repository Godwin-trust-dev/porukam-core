import type { Meta, StoryObj } from '@storybook/react';
import { StageRow } from './StageRow';

const meta: Meta<typeof StageRow> = {
  title: 'Компоненты/StageRow',
  component: StageRow,
};
export default meta;
type Story = StoryObj<typeof StageRow>;

export const Auto: Story = {
  args: { title: 'Демонтаж старого гарнитура', amount: { amount: '20000.00', currency: 'RUB' }, auto: true, durationDays: '5', onOpen: () => {}, onDelete: () => {} },
};

export const Manual: Story = {
  args: { title: 'Монтаж гарнитура', amount: { amount: '45000.00', currency: 'RUB' }, auto: false, durationDays: '7', onOpen: () => {}, onDelete: () => {} },
};

export const EmptyAmount: Story = {
  name: 'Без суммы (плейсхолдер)',
  args: { title: 'Финальная уборка', amount: null, auto: false, onOpen: () => {}, onDelete: () => {} },
};
