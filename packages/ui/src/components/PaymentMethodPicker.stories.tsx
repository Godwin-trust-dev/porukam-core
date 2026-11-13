import type { Meta, StoryObj } from '@storybook/react';
import { PaymentMethodPicker } from './PaymentMethodPicker';

const meta: Meta<typeof PaymentMethodPicker> = {
  title: 'Компоненты/PaymentMethodPicker',
  component: PaymentMethodPicker,
};
export default meta;
type Story = StoryObj<typeof PaymentMethodPicker>;

export const TwoMethods: Story = {
  args: {
    methods: [
      { kind: 'cash', label: 'Наличные' },
      { kind: 'sbp', label: 'СБП' },
    ],
    selected: 'sbp',
    onSelect: () => {},
    groupLabel: 'Способ платежа',
  },
};

export const OnlyCash: Story = {
  args: {
    methods: [{ kind: 'cash', label: 'Наличные' }],
    selected: 'cash',
    onSelect: () => {},
  },
};
