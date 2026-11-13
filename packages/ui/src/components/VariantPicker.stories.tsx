import type { Meta, StoryObj } from '@storybook/react';
import { VariantPicker } from './VariantPicker';

const meta: Meta<typeof VariantPicker> = {
  title: 'Компоненты/VariantPicker',
  component: VariantPicker,
};
export default meta;
type Story = StoryObj<typeof VariantPicker>;

const variants = [
  { id: 'v1', label: '60 000 ₽', note: 'с учётом доп. плитки' },
  { id: 'v2', label: '65 000 ₽', note: 'с доставкой материала' },
];

export const OneVariant: Story = {
  args: {
    fromLabel: 'Было',
    fromValue: '50 000 ₽',
    variants: [{ id: 'v1', label: '60 000 ₽', note: 'с учётом доп. плитки' }],
    ariaLabel: 'Варианты по пункту «Этап 3 · Укладка плитки»',
    pickLabel: 'Выбрать',
    onPick: () => {},
  },
};

export const MultiVariant: Story = {
  args: {
    ...OneVariant.args,
    variants,
  },
};

export const Disabled: Story = {
  args: {
    ...MultiVariant.args,
    disabled: true,
  },
};

export const Accepted: Story = {
  args: {
    ...MultiVariant.args,
    selectedVariantId: 'v1',
  },
};
