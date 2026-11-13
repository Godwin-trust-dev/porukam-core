import type { Meta, StoryObj } from '@storybook/react';
import { ActionMenu } from './ActionMenu';

const meta: Meta<typeof ActionMenu> = {
  title: 'Компоненты/ActionMenu',
  component: ActionMenu,
};
export default meta;
type Story = StoryObj<typeof ActionMenu>;

export const Default: Story = {
  args: {
    triggerLabel: 'Действия',
    initialOpen: true,
    items: [
      { key: 'open', label: 'Открыть', onSelect: () => {} },
      { key: 'archive', label: 'Экспортировать архив', onSelect: () => {} },
      { key: 'repeat', label: 'Как в прошлый раз', onSelect: () => {} },
    ],
  },
};

export const WithDestructive: Story = {
  args: {
    triggerLabel: 'Действия',
    items: [
      { key: 'continue', label: 'Продолжить', onSelect: () => {} },
      { key: 'delete', label: 'Удалить', destructive: true, onSelect: () => {} },
    ],
  },
};
