import type { Meta, StoryObj } from '@storybook/react';
import { MilestoneList } from './MilestoneList';

/**
 * Список этапов «только чтение» (DEV-19 §2/§4) — один и тот же компонент в
 * колонке деталей master-detail и в обзоре карточки договора.
 */
const meta: Meta<typeof MilestoneList> = {
  title: 'Компоненты/MilestoneList',
  component: MilestoneList,
  decorators: [(Story) => <div style={{ maxWidth: 640 }}>{Story()}</div>],
};
export default meta;
type Story = StoryObj<typeof MilestoneList>;

export const InProgress: Story = {
  args: {
    title: 'Этапы работ',
    countLabel: '2 / 4',
    progressPct: 50,
    nowLabel: 'сейчас',
    items: [
      { id: '1', title: 'Демонтаж', statusLabel: 'принят 12.08', done: true, amountLabel: '40 000 ₽' },
      { id: '2', title: 'Черновые работы', statusLabel: 'принят 16.08', done: true, amountLabel: '40 000 ₽' },
      { id: '3', title: 'Чистовая отделка', statusLabel: 'на приёмке · 48 ч', current: true, amountLabel: '40 000 ₽' },
      { id: '4', title: 'Электрика', statusLabel: 'ожидает', amountLabel: '20 000 ₽' },
    ],
  },
};

/** Кликабельные листья — ведут на страницу этапа. */
export const Openable: Story = {
  args: {
    ...InProgress.args,
    items: (InProgress.args!.items ?? []).map((m) => ({ ...m, onOpen: () => {} })),
  },
};

/** Черновик без этапов — пустое место читалось бы как «этапов ноль рублей». */
export const Empty: Story = {
  args: { title: 'Этапы', items: [], emptyText: 'Этапов пока нет.' },
};
