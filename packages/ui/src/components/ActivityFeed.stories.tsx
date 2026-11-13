import type { Meta, StoryObj } from '@storybook/react';
import { ActivityFeed } from './ActivityFeed';

const meta: Meta<typeof ActivityFeed> = {
  title: 'Компоненты/ActivityFeed',
  component: ActivityFeed,
};
export default meta;
type Story = StoryObj<typeof ActivityFeed>;

export const Filled: Story = {
  args: {
    title: 'Лента событий',
    items: [
      { icon: 'checklist', text: 'Этап «Демонтаж» принят заказчиком', time: '2 ч назад' },
      { icon: 'wallet', text: 'Поступила оплата 63 000 ₽', time: 'вчера' },
      { icon: 'contract', text: 'Договор «Электромонтаж» подписан обеими сторонами', time: '2 дня назад' },
    ],
    seeAllLabel: 'Все уведомления',
    onSeeAll: () => {},
  },
};

export const Empty: Story = {
  args: { title: 'Лента событий', items: [], seeAllLabel: 'Все уведомления', onSeeAll: () => {} },
};
