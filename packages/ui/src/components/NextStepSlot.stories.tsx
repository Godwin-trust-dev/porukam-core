import type { Meta, StoryObj } from '@storybook/react';
import { NextStepSlot } from './NextStepSlot';

const meta: Meta<typeof NextStepSlot> = {
  title: 'Компоненты/NextStepSlot',
  component: NextStepSlot,
};
export default meta;
type Story = StoryObj<typeof NextStepSlot>;

export const ActionEsica: Story = {
  args: {
    variant: 'action',
    title: 'Авторизуйтесь через Госуслуги',
    subtitle: 'Повысьте верификацию до уровня 3',
    onClick: () => {},
  },
};

export const ImportantNotice: Story = {
  args: {
    variant: 'notice',
    title: 'Договор ждёт вашей подписи',
    subtitle: 'Согласование завершено — осталось подписать',
    onClick: () => {},
  },
};

export const NothingToShow: Story = {
  name: 'Нечего показать (не рендерится)',
  args: {},
};
