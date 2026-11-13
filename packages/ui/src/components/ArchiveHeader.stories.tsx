import type { Meta, StoryObj } from '@storybook/react';
import { ArchiveHeader } from './ArchiveHeader';

const meta: Meta<typeof ArchiveHeader> = {
  title: 'Компоненты/ArchiveHeader',
  component: ArchiveHeader,
};
export default meta;
type Story = StoryObj<typeof ArchiveHeader>;

const base = { contractNo: '№ 2026-0301', counterparty: 'Мастер Ремонт (@masterremont)' };

export const Closed: Story = { args: { ...base, statusLabel: 'Закрыт', statusTone: 'green' } };
export const InWork: Story = { args: { ...base, statusLabel: 'В работе', statusTone: 'teal' } };
export const Terminated: Story = { args: { ...base, statusLabel: 'Расторгнут', statusTone: 'neutral' } };
