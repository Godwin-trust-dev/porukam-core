import type { Meta, StoryObj } from '@storybook/react';
import { Toast } from './Toast';

const meta: Meta<typeof Toast> = {
  title: 'Компоненты/Toast',
  component: Toast,
};
export default meta;
type Story = StoryObj<typeof Toast>;

export const DisabledLocale: Story = {
  name: 'отключённая локаль (DEV-16a §4)',
  args: { text: 'Français временно недоступен · показываем английский' },
};
