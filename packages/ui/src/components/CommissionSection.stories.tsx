import type { Meta, StoryObj } from '@storybook/react';
import { CommissionSection } from './CommissionSection';

const meta: Meta<typeof CommissionSection> = {
  title: 'Компоненты/CommissionSection',
  component: CommissionSection,
};
export default meta;
type Story = StoryObj<typeof CommissionSection>;

export const Default: Story = {
  args: {
    title: 'Комиссия за заключение',
    amountLabel: '1 020 ₽',
    percentLabel: '≈0.85 %',
    paidBy: 'ИП Мастер Ремонт',
    paidByLabel: 'Платит',
    payAtSigningNote: 'Оплачивается при подписании',
    nonRefundableNote: 'Комиссия невозвратная',
  },
};

export const WithoutPercent: Story = {
  args: {
    ...Default.args,
    percentLabel: undefined,
    nonRefundableNote: undefined,
  },
};
