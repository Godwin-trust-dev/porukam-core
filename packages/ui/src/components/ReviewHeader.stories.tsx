import type { Meta, StoryObj } from '@storybook/react';
import { ReviewHeader } from './ReviewHeader';

const meta: Meta<typeof ReviewHeader> = {
  title: 'Компоненты/ReviewHeader',
  component: ReviewHeader,
};
export default meta;
type Story = StoryObj<typeof ReviewHeader>;

export const YourTurn: Story = {
  args: {
    title: 'Ремонт кухни, 12 м²',
    statusLabel: 'Согласование',
    counterpartyName: 'Мастер Ремонт',
    viewerRoleLabel: 'Вы — заказчик',
    openCountLabel: '3 открытых правки',
    yourTurnCount: 2,
    yourTurnLabel: 'Ваш ход: 2',
    menuLabel: 'Действия с договором',
    onWithdraw: () => {},
    withdrawLabel: 'Отозвать договор',
    onChat: () => {},
    chatLabel: 'Чат сделки',
  },
};

export const NoOpenRevisions: Story = {
  args: {
    ...YourTurn.args,
    openCountLabel: '0 открытых правок',
    yourTurnCount: 0,
    yourTurnLabel: undefined,
  },
};
