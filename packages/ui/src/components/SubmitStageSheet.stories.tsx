import type { Meta, StoryObj } from '@storybook/react';
import { SubmitStageSheet } from './SubmitStageSheet';

const meta: Meta<typeof SubmitStageSheet> = {
  title: 'Компоненты/SubmitStageSheet',
  component: SubmitStageSheet,
};
export default meta;
type Story = StoryObj<typeof SubmitStageSheet>;

export const Open: Story = {
  args: {
    open: true,
    title: 'Сдать этап',
    onClose: () => {},
    closeLabel: 'Закрыть',
    willHappenTitle: 'Что произойдёт',
    items: [
      'Этап уходит на приёмку Заказчик Анна Свет (@anna_svet)',
      'Начнётся срок приёмки — 5 дней',
      'После сдачи доказательства этапа менять нельзя',
    ],
    confirmLabel: 'Подтвердить сдачу',
    cancelLabel: 'Отмена',
    onConfirm: () => {},
  },
};

export const WithError: Story = {
  args: { ...Open.args, errorText: 'Не удалось сдать этап' },
};
