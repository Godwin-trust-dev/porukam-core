import type { Meta, StoryObj } from '@storybook/react';
import { OfflineStub } from './OfflineStub';

const meta: Meta<typeof OfflineStub> = {
  title: 'Компоненты/OfflineStub',
  component: OfflineStub,
};
export default meta;
type Story = StoryObj<typeof OfflineStub>;

export const Default: Story = {
  args: {
    title: 'Нет соединения',
    text: 'Проверьте сеть и попробуйте снова',
    retryLabel: 'Повторить',
    onRetry: () => {},
  },
};
