import type { Meta, StoryObj } from '@storybook/react';
import { FreshProfileCard } from './FreshProfileCard';

const meta: Meta<typeof FreshProfileCard> = {
  title: 'Компоненты/FreshProfileCard',
  component: FreshProfileCard,
};
export default meta;
type Story = StoryObj<typeof FreshProfileCard>;

export const Default: Story = {
  args: {
    title: 'Fresh profile — honestly',
    ageLabel: 'Joined today',
    dealsLabel: '0 deals',
    contactsLabel: '0 counterparties',
    createCtaLabel: 'Create your first contract',
    onCreateCta: () => {},
    inviteCtaLabel: 'Invite a counterparty with a link',
    onInviteCta: () => {},
  },
};
