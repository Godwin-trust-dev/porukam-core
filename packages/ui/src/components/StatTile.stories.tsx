import type { Meta, StoryObj } from '@storybook/react';
import { StatTile } from './StatTile';

const meta: Meta<typeof StatTile> = {
  title: 'Компоненты/StatTile',
  component: StatTile,
};
export default meta;
type Story = StoryObj<typeof StatTile>;

export const Plain: Story = {
  args: { icon: 'contract', label: 'Портфолио' },
};

export const WithBadge: Story = {
  args: { icon: 'bell', label: 'Уведомления', badge: 3 },
};

export const BadgeOverflow: Story = {
  args: { icon: 'bell', label: 'Уведомления', badge: 140 },
};

export const Row: Story = {
  render: () => (
    <div style={{ display: 'flex', gap: 12 }}>
      <StatTile icon="bell" label="Уведомления" badge={3} />
      <StatTile icon="profile" label="Сохранённые контакты" />
      <StatTile icon="contract" label="Портфолио" />
    </div>
  ),
};
