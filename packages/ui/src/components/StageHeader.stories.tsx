import type { Meta, StoryObj } from '@storybook/react';
import { StageHeader } from './StageHeader';

const meta: Meta<typeof StageHeader> = {
  title: 'Компоненты/StageHeader',
  component: StageHeader,
};
export default meta;
type Story = StoryObj<typeof StageHeader>;

const base = {
  title: 'Укладка плитки в санузле',
  indexLabel: 'Этап 3 из 5',
  counterparty: 'Заказчик Анна Свет (@anna_svet)',
};

export const InWork: Story = { args: { ...base, statusLabel: 'В работе', statusTone: 'teal', deadlineLabel: 'Срок: 14 августа 2026 г.' } };
export const Suspended: Story = {
  args: { ...base, statusLabel: 'Приостановлен', statusTone: 'amber', deadlineLabel: 'Срок: 20 августа 2026 г.', shifted: true, shiftedLabel: 'сдвинут' },
};
export const UnderAcceptance: Story = { args: { ...base, statusLabel: 'На приёмке', statusTone: 'amber' } };
export const Accepted: Story = { args: { ...base, statusLabel: 'Принят', statusTone: 'green' } };
