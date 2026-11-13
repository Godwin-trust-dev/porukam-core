import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { SettingRow } from './SettingRow';

const meta: Meta<typeof SettingRow> = {
  title: 'Компоненты/SettingRow',
  component: SettingRow,
};
export default meta;
type Story = StoryObj<typeof SettingRow>;

export const ToggleRow: Story = {
  render: () => {
    const [checked, setChecked] = useState(true);
    return (
      <SettingRow
        label="Находимость по телефону"
        hint="Вас можно найти по номеру телефона в поиске контактов"
        control="toggle"
        checked={checked}
        onToggle={setChecked}
        toggleOnLabel="Вкл"
        toggleOffLabel="Выкл"
      />
    );
  },
};

export const SelectRow: Story = {
  render: () => {
    const [value, setValue] = useState('everyone');
    return (
      <SettingRow
        label="Кто видит карточку"
        hint="Кому доступна ваша публичная карточка репутации"
        control="select"
        value={value}
        onSelectChange={setValue}
        options={[
          { value: 'everyone', label: 'Все' },
          { value: 'contacts', label: 'Только сохранённые контакты' },
          { value: 'nobody', label: 'Никто' },
        ]}
      />
    );
  },
};

export const LinkRow: Story = {
  args: {
    label: 'Смена телефона',
    hint: 'Появится позже',
    control: 'link',
    onLinkClick: () => {},
  },
};

export const DangerRow: Story = {
  args: {
    label: 'Удалить аккаунт',
    control: 'link',
    danger: true,
    onLinkClick: () => {},
  },
};
