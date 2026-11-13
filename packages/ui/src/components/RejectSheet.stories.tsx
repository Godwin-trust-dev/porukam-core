import type { Meta, StoryObj } from '@storybook/react';
import { RejectSheet } from './RejectSheet';
import { closeLabel } from './__fixtures__/contractNewLabels';

const meta: Meta<typeof RejectSheet> = {
  title: 'Компоненты/RejectSheet',
  component: RejectSheet,
};
export default meta;
type Story = StoryObj<typeof RejectSheet>;

export const Open: Story = {
  args: {
    open: true,
    title: 'Отклонить правку',
    itemLabel: 'Этап 3 · Укладка плитки · сумма',
    onClose: () => {},
    onReject: () => {},
    onProposeCounter: () => {},
    closeLabel,
    cancelLabel: 'Отмена',
    rejectLabel: 'Отклонить',
    commentLabel: 'Комментарий (необязательно)',
    counterHintTitle: 'Может, предложите свою редакцию?',
    counterHintCta: 'Предложить свою редакцию',
  },
};
