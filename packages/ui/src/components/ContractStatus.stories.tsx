import type { Meta, StoryObj } from '@storybook/react';
import type { ContractCardStatus } from '@porukam/core';
import { ContractStatus } from './ContractStatus';

const meta: Meta<typeof ContractStatus> = {
  title: 'Компоненты/ContractStatus',
  component: ContractStatus,
};
export default meta;
type Story = StoryObj<typeof ContractStatus>;

export const InProgress: Story = {
  args: { status: 'in_progress', label: 'В работе', stageCaption: 'этап 2 из 4' },
};

export const Suspended: Story = {
  args: { status: 'suspended', label: 'Приостановлен', stageCaption: 'этап 2 из 4' },
};

export const Completed: Story = {
  args: { status: 'completed', label: 'Завершён' },
};

const ALL: { status: ContractCardStatus; label: string }[] = [
  { status: 'draft', label: 'Черновик' },
  { status: 'under_review', label: 'Согласование' },
  { status: 'rejected_by_counterparty', label: 'Отклонён' },
  { status: 'withdrawn_by_initiator', label: 'Отозван' },
  { status: 'pending_signature', label: 'Заморожен · ждёт подписания' },
  { status: 'awaiting_signatures', label: 'Ждёт подписей' },
  { status: 'signed', label: 'Подписан' },
  { status: 'in_progress', label: 'В работе' },
  { status: 'suspended', label: 'Приостановлен' },
  { status: 'completed', label: 'Завершён' },
  { status: 'terminated_by_customer', label: 'Расторгнут заказчиком' },
  { status: 'terminated_by_contractor', label: 'Расторгнут исполнителем' },
  { status: 'under_warranty', label: 'На гарантии' },
  { status: 'warranty_claim', label: 'Гарантийное обращение' },
];

export const AllStatuses: Story = {
  render: () => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'flex-start' }}>
      {ALL.map((s) => (
        <ContractStatus key={s.status} {...s} />
      ))}
    </div>
  ),
};
