import type { Meta, StoryObj } from '@storybook/react';
import { WaitingSubmission } from './WaitingSubmission';

const meta: Meta<typeof WaitingSubmission> = {
  title: 'Компоненты/WaitingSubmission',
  component: WaitingSubmission,
};
export default meta;
type Story = StoryObj<typeof WaitingSubmission>;

export const Planned: Story = {
  args: { scheduleLabel: 'Осталось 2 дня', tone: 'planned', chatLabel: 'Написать в чат', onChat: () => {} },
};

export const Delayed: Story = {
  args: { scheduleLabel: 'Задержка на 3 дня', tone: 'delayed', chatLabel: 'Написать в чат', onChat: () => {} },
};
