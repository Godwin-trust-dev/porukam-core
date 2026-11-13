import type { Meta, StoryObj } from '@storybook/react';
import { Spark } from './Spark';

const meta: Meta<typeof Spark> = {
  title: 'Основы/Искра',
  component: Spark,
  parameters: {
    docs: {
      description: {
        component:
          'Фирменная вспышка появляется ТОЛЬКО на событиях доверия/подтверждения (§5.1). В Ф1 — один раз, на успешном входе. Уважает prefers-reduced-motion.',
      },
    },
  },
};
export default meta;
type Story = StoryObj<typeof Spark>;

export const Default: Story = { args: { size: 96, title: 'По рукам' } };

export const OnInk: Story = {
  parameters: { backgrounds: { default: 'ink (dark UI)' } },
  args: { size: 120, title: 'Подтверждено' },
};
