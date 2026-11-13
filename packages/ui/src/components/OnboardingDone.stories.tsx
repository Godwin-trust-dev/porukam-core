import type { Meta, StoryObj } from '@storybook/react';
import { OnboardingDone } from './OnboardingDone';

const meta: Meta<typeof OnboardingDone> = {
  title: 'Компоненты/OnboardingDone',
  component: OnboardingDone,
};
export default meta;
type Story = StoryObj<typeof OnboardingDone>;

export const Default: Story = {
  args: { title: 'Welcome!', subtitle: 'Your account is ready.' },
};
