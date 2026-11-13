import type { Meta, StoryObj } from '@storybook/react';
import { SnapshotNote } from './SnapshotNote';

const meta: Meta<typeof SnapshotNote> = {
  title: 'Компоненты/SnapshotNote',
  component: SnapshotNote,
};
export default meta;
type Story = StoryObj<typeof SnapshotNote>;

export const Default: Story = {
  args: { text: 'Сделка ещё не закрыта. Пакет будет снимком на 8 авг 2026, 14:20' },
};
