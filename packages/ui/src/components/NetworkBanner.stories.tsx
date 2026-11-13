import type { Meta, StoryObj } from '@storybook/react';
import { NetworkBanner } from './NetworkBanner';

const meta: Meta<typeof NetworkBanner> = {
  title: 'Компоненты/NetworkBanner',
  component: NetworkBanner,
};
export default meta;
type Story = StoryObj<typeof NetworkBanner>;

export const Offline: Story = {
  args: { text: 'Нет сети' },
};

export const OfflineCached: Story = {
  args: { text: 'Нет сети · показано из кэша' },
};
