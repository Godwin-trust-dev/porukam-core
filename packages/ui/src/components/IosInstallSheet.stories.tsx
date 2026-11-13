import type { Meta, StoryObj } from '@storybook/react';
import { IosInstallSheet } from './IosInstallSheet';

const meta: Meta<typeof IosInstallSheet> = {
  title: 'Компоненты/IosInstallSheet',
  component: IosInstallSheet,
};
export default meta;
type Story = StoryObj<typeof IosInstallSheet>;

export const Open: Story = {
  args: {
    open: true,
    onClose: () => {},
    titleLabel: 'Установка на экран «Домой»',
    step1Label: 'Нажмите «Поделиться»',
    step2Label: 'Выберите «На экран „Домой"»',
    step3Label: 'Нажмите «Добавить»',
    pushHintLabel: 'Push-уведомления включатся после установки',
    closeLabel: 'Понятно',
  },
};
