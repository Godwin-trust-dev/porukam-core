import type { Meta, StoryObj } from '@storybook/react';
import { InviteBanner } from './InviteBanner';

const meta: Meta<typeof InviteBanner> = {
  title: 'Компоненты/InviteBanner',
  component: InviteBanner,
};
export default meta;
type Story = StoryObj<typeof InviteBanner>;

export const Valid: Story = {
  args: {
    variant: 'valid',
    titleText: 'Alex invited you',
    bodyText: 'Contract: Kitchen renovation, phase 1',
    actionLabel: 'Sign in and open the contract',
    onAction: () => {},
    expiredText: 'This invite link is invalid or has expired.',
  },
};

export const Expired: Story = {
  args: {
    variant: 'expired',
    actionLabel: '',
    onAction: () => {},
    expiredText: 'This invite link is invalid or has expired.',
  },
};
