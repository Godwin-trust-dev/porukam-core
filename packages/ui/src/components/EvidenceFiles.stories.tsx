import type { Meta, StoryObj } from '@storybook/react';
import { EvidenceFiles } from './EvidenceFiles';

const meta: Meta<typeof EvidenceFiles> = {
  title: 'Компоненты/EvidenceFiles',
  component: EvidenceFiles,
};
export default meta;
type Story = StoryObj<typeof EvidenceFiles>;

export const Default: Story = {
  args: {
    files: [
      { id: 'f1', name: 'Готовый пол, комната 1.jpg', kind: 'image', src: 'https://placehold.co/240x240' },
      { id: 'f2', name: 'Готовый пол, комната 2.jpg', kind: 'image', src: 'https://placehold.co/240x240' },
      { id: 'f3', name: 'Акт расхода материалов.pdf', kind: 'doc' },
    ],
    onOpen: () => {},
  },
};
