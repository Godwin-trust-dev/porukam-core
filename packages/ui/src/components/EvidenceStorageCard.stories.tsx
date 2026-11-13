import type { Meta, StoryObj } from '@storybook/react';
import { EvidenceStorageCard } from './EvidenceStorageCard';

const meta: Meta<typeof EvidenceStorageCard> = {
  title: 'Компоненты/EvidenceStorageCard',
  component: EvidenceStorageCard,
};
export default meta;
type Story = StoryObj<typeof EvidenceStorageCard>;

export const Default: Story = {
  args: {
    title: 'Хранение доказательств',
    countLabel: '24 файла',
    daysLeftLabel: 'Осталось 45 дней',
    downloadLabel: 'Скачать',
    extendLabel: 'Продлить',
    onDownload: () => {},
    onExtend: () => {},
  },
};
