import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { HandleField, type HandleFieldStatus } from './HandleField';

const meta: Meta<typeof HandleField> = {
  title: 'Компоненты/HandleField',
  component: HandleField,
};
export default meta;
type Story = StoryObj<typeof HandleField>;

const BASE = {
  label: '@handle',
  hint: 'Needed for your invite link.',
  checkingLabel: 'Checking…',
  availableLabel: 'Available',
  takenLabel: 'Taken',
  placeholder: 'yourname',
};

export const Idle: Story = {
  args: { ...BASE, value: '', onChange: () => {}, status: 'idle' },
};

export const Checking: Story = {
  args: { ...BASE, value: 'godwin', onChange: () => {}, status: 'checking' },
};

export const Available: Story = {
  args: { ...BASE, value: 'godwin', onChange: () => {}, status: 'available' },
};

export const Taken: Story = {
  args: { ...BASE, value: 'godwin', onChange: () => {}, status: 'taken' },
};

function Interactive(): JSX.Element {
  const [value, setValue] = useState('');
  const status: HandleFieldStatus = value.length === 0 ? 'idle' : value === 'godwin' ? 'taken' : 'available';
  return <HandleField {...BASE} value={value} onChange={setValue} status={status} />;
}
export const Interactive_: Story = { name: 'Интерактивный', render: () => <Interactive /> };
