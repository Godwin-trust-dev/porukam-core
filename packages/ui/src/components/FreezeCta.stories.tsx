import type { Meta, StoryObj } from '@storybook/react';
import { FreezeCta } from './FreezeCta';

const meta: Meta<typeof FreezeCta> = {
  title: 'Компоненты/FreezeCta',
  component: FreezeCta,
};
export default meta;
type Story = StoryObj<typeof FreezeCta>;

export const Active: Story = {
  args: {
    active: true,
    label: 'Заморозить и подписать',
    hint: 'Нет открытых правок — можно зафиксировать версию и перейти к подписанию',
    blockedHint: 'Заморозка доступна, когда не осталось открытых правок',
    onFreeze: () => {},
  },
};

export const Blocked: Story = {
  args: { ...Active.args, active: false },
};
