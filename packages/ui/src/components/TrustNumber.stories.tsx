import type { Meta, StoryObj } from '@storybook/react';
import { TrustNumber } from './TrustNumber';

const meta: Meta<typeof TrustNumber> = {
  title: 'Компоненты/TrustNumber',
  component: TrustNumber,
};
export default meta;
type Story = StoryObj<typeof TrustNumber>;

export const Default: Story = {
  args: {
    count: 198,
    volume: { amount: '57300000.00', currency: 'RUB' },
    completedLabel: 'завершённых договоров',
    volumeLabel: 'объём',
    sinceLabel: 'С 2019 года',
  },
};

export const NoHistoryYear: Story = {
  args: {
    count: 39,
    volume: { amount: '1250000.00', currency: 'RUB' },
    completedLabel: 'завершённых договоров',
    volumeLabel: 'объём',
  },
};
