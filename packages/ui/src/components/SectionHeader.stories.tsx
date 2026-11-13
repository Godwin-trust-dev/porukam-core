import type { Meta, StoryObj } from '@storybook/react';
import { SectionHeader } from './SectionHeader';

const meta: Meta<typeof SectionHeader> = {
  title: 'Компоненты/SectionHeader',
  component: SectionHeader,
};
export default meta;
type Story = StoryObj<typeof SectionHeader>;

export const Default: Story = {
  args: { title: 'Черновые работы', amount: { amount: '35000.00', currency: 'RUB' }, onDelete: () => {} },
};
