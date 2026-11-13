import type { Meta, StoryObj } from '@storybook/react';
import { AcceptanceTimer } from './AcceptanceTimer';

const meta: Meta<typeof AcceptanceTimer> = {
  title: 'Компоненты/AcceptanceTimer',
  component: AcceptanceTimer,
};
export default meta;
type Story = StoryObj<typeof AcceptanceTimer>;

export const Default: Story = {
  args: { valueLabel: '42 ч осталось', hint: 'Автоприёмка, если не ответите' },
};

export const SoonExpiring: Story = {
  args: { valueLabel: '1 ч 20 мин осталось', hint: 'Автоприёмка, если не ответите' },
};
