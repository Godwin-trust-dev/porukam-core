import type { Meta, StoryObj } from '@storybook/react';
import { SignatureRow } from './SignatureRow';

const meta: Meta<typeof SignatureRow> = {
  title: 'Компоненты/SignatureRow',
  component: SignatureRow,
};
export default meta;
type Story = StoryObj<typeof SignatureRow>;

const LABELS = { youLabel: 'Ваша подпись', waitingLabel: 'Ждём подпись', signedLabel: 'Подписано' };

export const You: Story = {
  args: { name: 'Годвин', role: 'Заказчик', state: 'you', ...LABELS },
};

export const Waiting: Story = {
  args: { name: 'Мастер Ремонт', role: 'Исполнитель', state: 'waiting', ...LABELS },
};

export const Signed: Story = {
  args: {
    name: 'Годвин',
    role: 'Заказчик',
    state: 'signed',
    signedAt: '2026-07-31T10:00:00.000Z',
    ...LABELS,
  },
};

export const SignedBusinessWithNote: Story = {
  args: {
    name: 'Мастер Ремонт',
    role: 'Исполнитель',
    state: 'signed',
    signedAt: '2026-07-31T10:05:00.000Z',
    signerNote: 'Подписывает Дмитрий Мастеров, ИП «Мастер Ремонт» — по праву единоличного исполнительного органа',
    ...LABELS,
  },
};
