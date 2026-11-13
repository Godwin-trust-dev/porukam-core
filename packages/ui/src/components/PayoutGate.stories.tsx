import type { Meta, StoryObj } from '@storybook/react';
import { PayoutGate } from './PayoutGate';

const meta: Meta<typeof PayoutGate> = {
  title: 'Компоненты/PayoutGate',
  component: PayoutGate,
};
export default meta;
type Story = StoryObj<typeof PayoutGate>;

export const Required: Story = {
  args: {
    required: true,
    title: 'Нужны реквизиты для получения оплаты',
    text: 'Добавьте реквизиты, чтобы получать оплату онлайн.',
    ctaLabel: 'Добавить реквизиты',
    onSetup: () => {},
  },
};

export const NotRequired: Story = {
  args: { ...Required.args, required: false },
};
