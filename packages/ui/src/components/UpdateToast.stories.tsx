import type { Meta, StoryObj } from '@storybook/react';
import { UpdateToast } from './UpdateToast';

const meta: Meta<typeof UpdateToast> = {
  title: 'Компоненты/UpdateToast',
  component: UpdateToast,
};
export default meta;
type Story = StoryObj<typeof UpdateToast>;

export const Default: Story = {
  args: {
    text: 'Доступна новая версия',
    updateLabel: 'Обновить',
    dismissAriaLabel: 'Отложить',
    onUpdate: () => {},
    onDismiss: () => {},
  },
};
