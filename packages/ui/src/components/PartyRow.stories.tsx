import type { Meta, StoryObj } from '@storybook/react';
import { PartyRow } from './PartyRow';

const meta: Meta<typeof PartyRow> = {
  title: 'Компоненты/PartyRow',
  component: PartyRow,
};
export default meta;
type Story = StoryObj<typeof PartyRow>;

const LABELS = { signedLabel: 'Подписал', pendingLabel: 'Ожидает' };

export const Signed: Story = {
  args: { name: 'Годвин', role: 'Заказчик', signState: 'signed', signedAt: '2026-07-31T10:00:00.000Z', ...LABELS },
};

export const Pending: Story = {
  args: { name: 'Мастер Ремонт', role: 'Исполнитель', signState: 'pending', ...LABELS },
};
