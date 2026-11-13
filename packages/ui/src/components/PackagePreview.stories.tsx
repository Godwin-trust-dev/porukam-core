import type { Meta, StoryObj } from '@storybook/react';
import { PackagePreview } from './PackagePreview';

const meta: Meta<typeof PackagePreview> = {
  title: 'Компоненты/PackagePreview',
  component: PackagePreview,
};
export default meta;
type Story = StoryObj<typeof PackagePreview>;

export const Complete: Story = {
  args: {
    sections: [
      { key: 'contract', label: 'Договор и все версии', sub: 'v2 · подписан 3 июля 2026', complete: true },
      { key: 'milestones', label: 'Этапы и чек-листы', sub: '5 этапов, все приняты', complete: true },
      { key: 'evidence', label: 'Доказательства', sub: '9 файлов', complete: true },
      { key: 'payments', label: 'Платежи', sub: 'все проведены', complete: true },
    ],
  },
};

export const Partial: Story = {
  args: {
    sections: [
      { key: 'contract', label: 'Договор и все версии', sub: 'v1 · подписан', complete: true },
      { key: 'milestones', label: 'Этапы и чек-листы', sub: '2 из 5 приняты', complete: false, countLabel: '5' },
      { key: 'evidence', label: 'Доказательства', complete: false, countLabel: '5,4 МБ' },
      { key: 'payments', label: 'Платежи', sub: '2 из 5 проведены', complete: false, countLabel: '5' },
    ],
  },
};
