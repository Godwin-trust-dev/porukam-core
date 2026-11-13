import type { Meta, StoryObj } from '@storybook/react';
import { MiniStepper } from './MiniStepper';

const meta: Meta<typeof MiniStepper> = {
  title: 'Компоненты/MiniStepper',
  component: MiniStepper,
};
export default meta;
type Story = StoryObj<typeof MiniStepper>;

export const Default: Story = { args: { done: 3, total: 5, label: '3 из 5' } };
export const JustStarted: Story = { args: { done: 0, total: 4, label: '0 из 4' } };
export const AlmostDone: Story = { args: { done: 4, total: 5, label: '4 из 5' } };
