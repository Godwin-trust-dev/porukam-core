import type { Meta, StoryObj } from '@storybook/react';
import { HashList } from './HashList';

const meta: Meta<typeof HashList> = {
  title: 'Компоненты/HashList',
  component: HashList,
};
export default meta;
type Story = StoryObj<typeof HashList>;

export const Default: Story = {
  args: {
    rows: [
      { file: 'договор.pdf', hash: 'sha256: a1b2c3d4e5f6…' },
      { file: 'доказательство-01.jpg', hash: 'sha256: 9f8e7d6c5b4a…' },
    ],
    timestampLabel: 'time-stamp → RFC 3161 · 5 авг 2026',
  },
};
