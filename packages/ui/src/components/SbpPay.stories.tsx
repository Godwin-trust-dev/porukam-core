import type { Meta, StoryObj } from '@storybook/react';
import { SbpPay } from './SbpPay';

const meta: Meta<typeof SbpPay> = {
  title: 'Компоненты/SbpPay',
  component: SbpPay,
};
export default meta;
type Story = StoryObj<typeof SbpPay>;

const BASE = {
  amountLabel: '45 000 ₽',
  banks: ['Т-Банк', 'Сбербанк', 'Альфа-Банк'],
  qrHint: 'QR-код для оплаты через СБП',
  banksLabel: 'Или откройте приложение банка',
};

export const Pending: Story = {
  args: { ...BASE, status: 'pending', statusLabel: 'Ожидаем подтверждение банка' },
};

export const Succeeded: Story = {
  args: { ...BASE, status: 'succeeded', statusLabel: 'Оплачено' },
};

export const Failed: Story = {
  args: { ...BASE, status: 'failed', statusLabel: 'Не прошло' },
};
