import type { Meta, StoryObj } from '@storybook/react';
import { PackageOptions } from './PackageOptions';

const meta: Meta<typeof PackageOptions> = {
  title: 'Компоненты/PackageOptions',
  component: PackageOptions,
};
export default meta;
type Story = StoryObj<typeof PackageOptions>;

const base = {
  onChange: () => {},
  groupLabel: 'Что включить в архив',
  fullLabel: 'Полный пакет',
  fullHint: 'Оригиналы из Google Drive — тяжелее',
  thumbnailsLabel: 'Миниатюры',
  thumbnailsHint: 'Превью файлов + манифест хешей',
  manifestLabel: 'Только манифест',
  manifestHint: 'Список и хеши файлов, без самих файлов — самый лёгкий',
};

export const DriveConnected: Story = { args: { ...base, value: 'full' } };
export const DriveOff: Story = {
  args: { ...base, value: 'thumbnails', fullDisabled: true, fullDisabledHint: 'оригиналы у вас; подключите Drive или приложите сами' },
};
