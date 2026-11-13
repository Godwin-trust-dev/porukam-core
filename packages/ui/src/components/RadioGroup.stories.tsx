import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { RadioGroup } from './RadioGroup';

const meta: Meta<typeof RadioGroup> = {
  title: 'Компоненты/RadioGroup',
  component: RadioGroup,
};
export default meta;
type Story = StoryObj<typeof RadioGroup>;

const OPTIONS = [
  { value: 'public', label: 'Public profile', badge: 'recommended' },
  { value: 'link_and_deals', label: 'Only by link and in deals' },
];

export const NoDefault: Story = {
  name: 'Без дефолта',
  args: { options: OPTIONS, value: null, onChange: () => {}, ariaLabel: 'Who can see your profile?' },
};

export const Selected: Story = {
  args: { options: OPTIONS, value: 'public', onChange: () => {}, ariaLabel: 'Who can see your profile?' },
};

function Interactive(): JSX.Element {
  const [value, setValue] = useState<string | null>(null);
  return <RadioGroup options={OPTIONS} value={value} onChange={setValue} ariaLabel="Who can see your profile?" />;
}
export const Interactive_: Story = { name: 'Интерактивный', render: () => <Interactive /> };
