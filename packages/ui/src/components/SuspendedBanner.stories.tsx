import type { Meta, StoryObj } from '@storybook/react';
import { SuspendedBanner } from './SuspendedBanner';

const meta: Meta<typeof SuspendedBanner> = {
  title: 'Компоненты/SuspendedBanner',
  component: SuspendedBanner,
};
export default meta;
type Story = StoryObj<typeof SuspendedBanner>;

export const Default: Story = {
  args: {
    title: 'Ждём материалы или доступ',
    text: 'Работа приостановлена — как только условие будет выполнено, этап возобновится.',
    shiftedLabel: 'Срок сдвинут',
  },
};
