import type { Meta, StoryObj } from '@storybook/react';
import { ReadyState } from './ReadyState';

const meta: Meta<typeof ReadyState> = {
  title: 'Компоненты/ReadyState',
  component: ReadyState,
};
export default meta;
type Story = StoryObj<typeof ReadyState>;

export const Default: Story = {
  args: {
    title: 'Архив готов',
    pdfLabel: 'Скачать PDF',
    pdfSizeLabel: '3,1 МБ',
    onDownloadPdf: () => {},
    zipLabel: 'Скачать ZIP',
    zipSizeLabel: '21,4 МБ',
    onDownloadZip: () => {},
    expiresLabel: 'Ссылки активны 30 дней · собрать заново можно всегда',
    readmeHint: 'В архиве — README с инструкцией по проверке',
  },
};
