import type { Meta, StoryObj } from '@storybook/react';
import { PushPromo } from './PushPromo';

const meta: Meta<typeof PushPromo> = {
  title: 'Компоненты/PushPromo',
  component: PushPromo,
};
export default meta;
type Story = StoryObj<typeof PushPromo>;

export const Default: Story = {
  args: {
    titleLabel: 'Разрешите отправлять уведомления, чтобы не пропустить сроки',
    enableLabel: 'Включить',
    dismissAriaLabel: 'Скрыть',
    onEnable: () => {},
    onDismiss: () => {},
  },
};
