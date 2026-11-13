import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { Checkbox } from './Checkbox';

const meta: Meta<typeof Checkbox> = {
  title: 'Компоненты/Checkbox',
  component: Checkbox,
};
export default meta;
type Story = StoryObj<typeof Checkbox>;

export const Unchecked: Story = {
  args: { checked: false, onChange: () => {}, label: 'I agree' },
};

export const Checked: Story = {
  args: { checked: true, onChange: () => {}, label: 'I agree' },
};

export const WithHint: Story = {
  args: { checked: false, onChange: () => {}, label: 'I agree', hint: 'You can withdraw this in settings later.' },
};

function Interactive(): JSX.Element {
  const [checked, setChecked] = useState(false);
  return <Checkbox checked={checked} onChange={setChecked} label="I agree" required />;
}
export const Interactive_: Story = { name: 'Интерактивный', render: () => <Interactive /> };
