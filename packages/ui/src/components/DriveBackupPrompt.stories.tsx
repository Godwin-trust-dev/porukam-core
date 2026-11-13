import type { Meta, StoryObj } from '@storybook/react';
import { DriveBackupPrompt } from './DriveBackupPrompt';

const meta: Meta<typeof DriveBackupPrompt> = {
  title: 'Компоненты/DriveBackupPrompt',
  component: DriveBackupPrompt,
};
export default meta;
type Story = StoryObj<typeof DriveBackupPrompt>;

export const Open: Story = {
  args: {
    open: true,
    title: 'Сохраните оригиналы у себя',
    text: 'Резервная копия в Google Drive — оригинал останется у вас, даже если что-то случится с устройством.',
    connectLabel: 'Подключить Drive',
    laterLabel: 'Позже',
    closeLabel: 'Закрыть',
    onConnect: () => {},
    onLater: () => {},
  },
};
