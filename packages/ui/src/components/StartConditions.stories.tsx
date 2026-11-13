import type { Meta, StoryObj } from '@storybook/react';
import { StartConditions } from './StartConditions';

const meta: Meta<typeof StartConditions> = {
  title: 'Компоненты/StartConditions',
  component: StartConditions,
};
export default meta;
type Story = StoryObj<typeof StartConditions>;

const stateLabels = { met: 'Готово', waiting: 'Ждём', na: 'Не требуется' };

export const Ready: Story = {
  args: {
    title: 'Что нужно для старта',
    items: [
      { key: 'contract_signed', label: 'Договор подписан', state: 'met', linkRef: 'contract' },
      { key: 'materials', label: 'Материалы получены', state: 'met', sub: '5 из 5 позиций', linkRef: 'materials' },
      { key: 'advance', label: 'Аванс получен', state: 'na' },
      { key: 'access', label: 'Доступ к объекту', state: 'met' },
    ],
    stateLabels,
    openLabel: 'Открыть',
    onOpen: () => {},
  },
};

export const Waiting: Story = {
  args: {
    ...Ready.args,
    items: [
      { key: 'contract_signed', label: 'Договор подписан', state: 'met', linkRef: 'contract' },
      { key: 'materials', label: 'Материалы получены', state: 'waiting', sub: '2 из 5 позиций', linkRef: 'materials' },
    ],
  } as typeof Ready.args,
};
