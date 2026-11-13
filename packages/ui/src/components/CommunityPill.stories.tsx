import type { Meta, StoryObj } from '@storybook/react';
import { CommunityPill } from './CommunityPill';

const meta: Meta<typeof CommunityPill> = {
  title: 'Компоненты/CommunityPill',
  component: CommunityPill,
};
export default meta;
type Story = StoryObj<typeof CommunityPill>;

export const Light: Story = {
  render: () => (
    <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
      <CommunityPill name="Гильдия мастеров ремонта" verified verifiedLabel="Объединение проверено" />
      <CommunityPill name="Сообщество «Тёплый дом»" verified={false} />
    </div>
  ),
};

export const OnInk: Story = {
  render: () => (
    <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', padding: 24, background: 'var(--pr-grad-ink)', borderRadius: 16 }}>
      <CommunityPill name="Гильдия мастеров ремонта" verified verifiedLabel="Объединение проверено" />
      <CommunityPill name="Сообщество «Тёплый дом»" verified={false} />
    </div>
  ),
  parameters: { backgrounds: { default: 'ink (dark UI)' } },
};
