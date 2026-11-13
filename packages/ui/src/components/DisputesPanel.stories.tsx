import type { Meta, StoryObj } from '@storybook/react';
import { DisputesPanel } from './DisputesPanel';

const meta: Meta<typeof DisputesPanel> = {
  title: 'Компоненты/DisputesPanel',
  component: DisputesPanel,
};
export default meta;
type Story = StoryObj<typeof DisputesPanel>;

export const Empty: Story = {
  args: {
    title: 'Разногласия',
    items: [],
    onOpen: () => {},
    emptyTitle: 'Открытых правок нет',
  },
};

export const WithList: Story = {
  args: {
    ...Empty.args,
    items: [
      { id: 'rev-1', itemLabel: 'Этап 3 · Укладка плитки · сумма', statusLabel: 'открыта', statusTone: 'amber', turnLabel: 'Ваш ход' },
      { id: 'rev-2', itemLabel: 'Гарантия', statusLabel: 'открыта', statusTone: 'amber', turnLabel: 'Ход контрагента' },
      { id: 'rev-3', itemLabel: 'Срок', statusLabel: 'принята', statusTone: 'green', turnLabel: '' },
    ],
  },
};
