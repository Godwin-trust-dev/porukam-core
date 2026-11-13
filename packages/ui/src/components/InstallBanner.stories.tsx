import type { Meta, StoryObj } from '@storybook/react';
import { InstallBanner } from './InstallBanner';

const meta: Meta<typeof InstallBanner> = {
  title: 'Компоненты/InstallBanner',
  component: InstallBanner,
};
export default meta;
type Story = StoryObj<typeof InstallBanner>;

export const Default: Story = {
  args: {
    titleLabel: 'Установите Porukam на телефон — быстрый доступ с экрана',
    installLabel: 'Установить',
    dismissAriaLabel: 'Скрыть',
    onInstall: () => {},
    onDismiss: () => {},
  },
};
