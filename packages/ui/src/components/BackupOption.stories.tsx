import type { Meta, StoryObj } from '@storybook/react';
import { BackupOption } from './BackupOption';

const meta: Meta<typeof BackupOption> = {
  title: 'Компоненты/BackupOption',
  component: BackupOption,
};
export default meta;
type Story = StoryObj<typeof BackupOption>;

const BASE = {
  title: 'Back up your evidence',
  text: 'The platform keeps a hash and a thumbnail; originals stay with you and your counterparty.',
  connectLabel: 'Connect Google Drive',
  skipLabel: 'Later',
  connectedLabel: 'Connected to Google Drive',
};

export const NotConnected: Story = {
  args: { ...BASE, connected: false, onConnect: () => {}, onSkip: () => {} },
};

export const Loading: Story = {
  args: { ...BASE, connected: false, loading: true, onConnect: () => {}, onSkip: () => {} },
};

export const Connected: Story = {
  args: { ...BASE, connected: true, onConnect: () => {}, onSkip: () => {} },
};

export const ErrorState: Story = {
  name: 'Ошибка',
  args: { ...BASE, connected: false, error: "Couldn't connect Google Drive.", onConnect: () => {}, onSkip: () => {} },
};
