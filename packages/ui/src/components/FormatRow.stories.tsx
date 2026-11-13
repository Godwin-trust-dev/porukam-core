import type { Meta, StoryObj } from '@storybook/react';
import { FormatRow } from './FormatRow';

const meta: Meta<typeof FormatRow> = {
  title: 'Компоненты/FormatRow',
  component: FormatRow,
};
export default meta;
type Story = StoryObj<typeof FormatRow>;

export const Default: Story = {
  args: {
    pdfLabel: 'PDF',
    pdfHint: 'Отчёт с оглавлением — для чтения',
    pdfSizeLabel: '3,1 МБ',
    zipLabel: 'ZIP',
    zipHint: 'Файлы + манифест хешей — для проверки',
    zipSizeLabel: '21,4 МБ',
  },
};
