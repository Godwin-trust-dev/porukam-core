import type { Meta, StoryObj } from '@storybook/react';
import { CookieBanner } from './CookieBanner';

const meta: Meta<typeof CookieBanner> = {
  title: 'Компоненты/CookieBanner',
  component: CookieBanner,
};
export default meta;
type Story = StoryObj<typeof CookieBanner>;

export const Default: Story = {
  args: {
    text: 'By default we use only necessary cookies (privacy-first).',
    acceptAllLabel: 'Accept all',
    necessaryOnlyLabel: 'Necessary only',
    onAcceptAll: () => {},
    onNecessaryOnly: () => {},
  },
};
