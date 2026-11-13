import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { Toggle } from './Toggle';

const meta: Meta<typeof Toggle> = {
  title: 'Компоненты/Toggle',
  component: Toggle,
};
export default meta;
type Story = StoryObj<typeof Toggle>;

function Interactive(): JSX.Element {
  const [checked, setChecked] = useState(false);
  return <Toggle checked={checked} onChange={setChecked} label="Находимость по телефону" onLabel="Вкл" offLabel="Выкл" />;
}

export const On: Story = {
  args: { checked: true, onChange: () => {}, onLabel: 'Вкл', offLabel: 'Выкл' },
};

export const Off: Story = {
  args: { checked: false, onChange: () => {}, onLabel: 'Вкл', offLabel: 'Выкл' },
};

export const Disabled: Story = {
  args: { checked: true, onChange: () => {}, disabled: true },
};

export const Interactive_: Story = {
  name: 'Интерактивный',
  render: () => <Interactive />,
};
