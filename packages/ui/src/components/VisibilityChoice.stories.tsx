import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { VisibilityChoice, type ProfileVisibilityValue } from './VisibilityChoice';

const meta: Meta<typeof VisibilityChoice> = {
  title: 'Компоненты/VisibilityChoice',
  component: VisibilityChoice,
};
export default meta;
type Story = StoryObj<typeof VisibilityChoice>;

const BASE = {
  title: 'Who can see your profile?',
  publicLabel: 'Public profile',
  publicBadge: 'recommended',
  linkOnlyLabel: 'Only by link and in deals',
  hint: 'You can change this later in settings.',
  ariaLabel: 'Who can see your profile?',
};

export const NoDefault: Story = {
  name: 'Без дефолта',
  args: { ...BASE, value: null, onChange: () => {} },
};

export const PublicSelected: Story = {
  args: { ...BASE, value: 'public', onChange: () => {} },
};

function Interactive(): JSX.Element {
  const [value, setValue] = useState<ProfileVisibilityValue | null>(null);
  return <VisibilityChoice {...BASE} value={value} onChange={setValue} />;
}
export const Interactive_: Story = { name: 'Интерактивный', render: () => <Interactive /> };
