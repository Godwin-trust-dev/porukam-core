import type { Meta, StoryObj } from '@storybook/react';
import { ExportCta } from './ExportCta';

const meta: Meta<typeof ExportCta> = {
  title: 'Компоненты/ExportCta',
  component: ExportCta,
};
export default meta;
type Story = StoryObj<typeof ExportCta>;

export const Default: Story = { args: { label: 'Собрать архив', hint: 'Бесплатно · PDF + ZIP', onClick: () => {} } };
export const Snapshot: Story = { args: { label: 'Собрать снимок', hint: 'Бесплатно · PDF + ZIP', onClick: () => {} } };
export const Loading: Story = { args: { label: 'Собрать архив', hint: 'Бесплатно · PDF + ZIP', onClick: () => {}, loading: true } };
