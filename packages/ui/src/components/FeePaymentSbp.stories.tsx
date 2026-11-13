import type { Meta, StoryObj } from '@storybook/react';
import { FeePaymentSbp } from './FeePaymentSbp';

const meta: Meta<typeof FeePaymentSbp> = {
  title: 'Компоненты/FeePaymentSbp',
  component: FeePaymentSbp,
};
export default meta;
type Story = StoryObj<typeof FeePaymentSbp>;

export const Default: Story = {
  args: {
    title: 'Оплата комиссии за заключение',
    amountLabel: '1 020 ₽',
    contractNo: 'c-3002',
    contractNoLabel: 'Договор №',
    steps: ['Откройте приложение банка', 'Отсканируйте QR-код', 'Подтвердите оплату в приложении банка'],
    nonRefundableNote: 'Комиссия невозвратная',
    payLabel: 'Оплатить',
    onPay: () => {},
    qrHint: 'QR-код для оплаты через СБП',
  },
};

export const Loading: Story = {
  args: { ...Default.args, loading: true },
};
