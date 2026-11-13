import type { Meta, StoryObj } from '@storybook/react';
import { StageTree } from './StageTree';

const meta: Meta<typeof StageTree> = {
  title: 'Компоненты/StageTree',
  component: StageTree,
};
export default meta;
type Story = StoryObj<typeof StageTree>;

export const Mixed: Story = {
  args: {
    openLabel: 'Открыть этап',
    onOpen: () => {},
    stages: [
      { id: 'ms-1', ix: 1, name: 'Демонтаж', sum: { amount: '20000.00', currency: 'RUB' }, status: 'accepted', statusLabel: 'Принят' },
      {
        id: 'ms-2',
        ix: 2,
        name: 'Черновые работы',
        meta: 'ждём материалы от заказчика',
        sum: { amount: '50000.00', currency: 'RUB' },
        status: 'suspended',
        statusLabel: 'Приостановлен',
      },
      { id: 'ms-3', ix: 3, name: 'Чистовая отделка', meta: 'срок до 12 августа', sum: { amount: '50000.00', currency: 'RUB' }, status: 'waiting_gate', statusLabel: 'Ждёт начала' },
    ],
  },
};

/** Черновик/согласование — исполнение не началось, статусов у листьев нет,
 * чипы не рендерятся (пустой серый бейдж был дефектом — отсмотр DEV-17). */
export const DraftNoStatuses: Story = {
  args: {
    stages: [
      { id: 'ms-1', ix: 1, name: 'Сборка каркаса', sum: { amount: '2500.00', currency: 'RUB' } },
      { id: 'ms-2', ix: 2, name: 'Навеска дверей и полок', sum: { amount: '1500.00', currency: 'RUB' } },
    ],
  },
};
