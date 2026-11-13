import type { Meta, StoryObj } from '@storybook/react';
import { PaymentResult } from './PaymentResult';

const meta: Meta<typeof PaymentResult> = {
  title: 'Компоненты/PaymentResult',
  component: PaymentResult,
};
export default meta;
type Story = StoryObj<typeof PaymentResult>;

export const Succeeded: Story = {
  args: {
    state: 'succeeded',
    title: 'Переведено',
    summaryChip: '45 000 ₽ · СБП · 14:32',
    doneLabel: 'Готово',
    onDone: () => {},
  },
};

export const Failed: Story = {
  args: {
    state: 'failed',
    title: 'Платёж не прошёл',
    errorText: 'Банк отклонил операцию. Попробуйте ещё раз.',
    retryLabel: 'Повторить',
    onRetry: () => {},
  },
};
