import type { Meta, StoryObj } from '@storybook/react';
import { Avatar } from './Avatar';

const meta: Meta<typeof Avatar> = {
  title: 'Компоненты/Avatar',
  component: Avatar,
};
export default meta;
type Story = StoryObj<typeof Avatar>;

/** §2: цвет круга детерминирован по имени/хендлу — контрагент узнаётся по нему. */
export const Инициалы: Story = {
  render: () => (
    <div style={{ display: 'flex', gap: 8 }}>
      {['Анна Ковалёва', 'Дмитрий Волков', 'Мария Соколова', 'Иван Петров', 'София Мельник'].map((name) => (
        <Avatar key={name} name={name} />
      ))}
    </div>
  ),
};

export const Крупный: Story = {
  args: { name: 'Анна Ковалёва', size: 54 },
};
