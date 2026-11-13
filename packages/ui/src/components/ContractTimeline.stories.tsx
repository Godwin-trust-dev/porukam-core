import type { Meta, StoryObj } from '@storybook/react';
import { ContractTimeline } from './ContractTimeline';

const meta: Meta<typeof ContractTimeline> = {
  title: 'Компоненты/ContractTimeline',
  component: ContractTimeline,
};
export default meta;
type Story = StoryObj<typeof ContractTimeline>;

export const Basic: Story = {
  args: {
    events: [
      { id: 'e1', title: 'Договор подписан обеими сторонами', at: '22 июл, 10:14', who: 'система', done: true },
      { id: 'e2', title: 'Этап «Демонтаж» принят и оплачен', at: '24 июл, 15:02', who: 'заказчик', done: true },
      { id: 'e3', title: 'Этап «Черновые работы» приостановлен', at: '26 июл, 09:40', who: 'исполнитель', done: false },
    ],
  },
};
