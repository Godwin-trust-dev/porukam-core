import type { Meta, StoryObj } from '@storybook/react';
import { PreapprovedBlock } from './PreapprovedBlock';

const meta: Meta<typeof PreapprovedBlock> = {
  title: 'Компоненты/PreapprovedBlock',
  component: PreapprovedBlock,
};
export default meta;
type Story = StoryObj<typeof PreapprovedBlock>;

export const OneItem: Story = {
  args: {
    title: 'Предодобренные альтернативы',
    pickLabel: 'Принять в 1 клик',
    onApply: () => {},
    items: [
      {
        id: 'pa-1',
        itemLabel: 'Срок',
        ariaLabel: 'Варианты по пункту «Срок»',
        fromLabel: 'Было',
        fromValue: '5 дней',
        variants: [{ id: 'v1', label: '7 дней' }],
      },
    ],
  },
};

export const MultipleVariants: Story = {
  args: {
    ...OneItem.args,
    items: [
      {
        id: 'pa-1',
        itemLabel: 'Срок',
        ariaLabel: 'Варианты по пункту «Срок»',
        fromLabel: 'Было',
        fromValue: '5 дней',
        variants: [
          { id: 'v1', label: '7 дней' },
          { id: 'v2', label: '10 дней', note: 'с учётом закупки материала' },
        ],
      },
    ],
  },
};
