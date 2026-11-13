import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { SettingsNav } from './SettingsNav';

const meta: Meta<typeof SettingsNav> = {
  title: 'Компоненты/SettingsNav',
  component: SettingsNav,
};
export default meta;
type Story = StoryObj<typeof SettingsNav>;

const ITEMS = [
  { key: 'profile', label: 'Профиль' },
  { key: 'privacy', label: 'Приватность' },
  { key: 'notifications', label: 'Уведомления' },
  { key: 'security', label: 'Безопасность' },
  { key: 'account', label: 'Аккаунт' },
];

export const Default: Story = {
  render: () => {
    const [active, setActive] = useState('profile');
    return <SettingsNav items={ITEMS} active={active} onSelect={setActive} ariaLabel="Настройки" />;
  },
};
