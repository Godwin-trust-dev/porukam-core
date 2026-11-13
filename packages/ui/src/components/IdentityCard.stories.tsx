import type { Meta, StoryObj } from '@storybook/react';
import { IdentityCard } from './IdentityCard';
import { identityCardFixtureLabels } from './__fixtures__/contractNewLabels';

const meta: Meta<typeof IdentityCard> = {
  title: 'Компоненты/IdentityCard',
  component: IdentityCard,
};
export default meta;
type Story = StoryObj<typeof IdentityCard>;

export const Default: Story = {
  args: {
    name: 'Годвин',
    maskedEmail: 'go••••n@example.com',
    provider: 'google',
    verified: true,
    ...identityCardFixtureLabels,
  },
};
