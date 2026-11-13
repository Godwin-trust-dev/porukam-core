import type { Meta, StoryObj } from '@storybook/react';
import { GeneratingState } from './GeneratingState';

const meta: Meta<typeof GeneratingState> = {
  title: 'Компоненты/GeneratingState',
  component: GeneratingState,
};
export default meta;
type Story = StoryObj<typeof GeneratingState>;

const base = { title: 'Готовим архив…', hint: 'Можно уйти — придёт уведомление, когда будет готово' };

export const Started: Story = { args: { ...base, progress: 20 } };
export const Halfway: Story = { args: { ...base, progress: 60 } };
export const AlmostDone: Story = { args: { ...base, progress: 95 } };
