import type { Meta, StoryObj } from '@storybook/react';
import { StageMaterials } from './StageMaterials';

const meta: Meta<typeof StageMaterials> = {
  title: 'Компоненты/StageMaterials',
  component: StageMaterials,
};
export default meta;
type Story = StoryObj<typeof StageMaterials>;

export const Mixed: Story = {
  args: {
    stateLabels: { received: 'Получено', expected: 'Ожидается', problem: 'Проблема' },
    problemActionLabel: 'Открыть окно оспаривания',
    problemNote: 'По одному из материалов заявлена проблема — окно оспаривания открыто 3 дня.',
    onOpenProblem: () => {},
    materials: [
      { id: 'mat-1', name: 'Ламинат 42 м²', suppliedBy: 'Заказчик', due: 'до 5 августа', state: 'received' },
      { id: 'mat-2', name: 'Плинтус', suppliedBy: 'Исполнитель', due: 'до 6 августа', state: 'expected' },
      { id: 'mat-3', name: 'Клей для плитки', suppliedBy: 'Заказчик', state: 'problem' },
    ],
  },
};
