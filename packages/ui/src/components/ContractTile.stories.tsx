import type { Meta, StoryObj } from '@storybook/react';
import { CardGrid } from '../layout/CardGrid';
import { ContractTile, CreateContractTile } from './ContractTile';

/** Плитка сделки для грида дашборда (DEV-19 §3). */
const meta: Meta<typeof ContractTile> = {
  title: 'Компоненты/ContractTile',
  component: ContractTile,
};
export default meta;
type Story = StoryObj<typeof ContractTile>;

export const InProgress: Story = {
  args: {
    no: 'PR-1042',
    title: 'Ремонт кухни',
    status: 'in_progress',
    statusLabel: 'В работе',
    metaLabel: 'Анна К. · Вы — заказчик',
    amountLabel: '120 000 ₽',
    payLabel: 'Платёж под защитой',
    onOpen: () => {},
  },
  decorators: [(Story) => <div style={{ maxWidth: 320 }}>{Story()}</div>],
};

export const Muted: Story = {
  args: { ...InProgress.args, status: 'terminated_by_customer', statusLabel: 'Расторгнут заказчиком', muted: true },
  decorators: InProgress.decorators,
};

/** Длинное название — две строки и обрезка, плитки в ряду стоят ровно. */
export const LongTitle: Story = {
  args: {
    ...InProgress.args,
    title: 'Ремонт кухни под ключ с заменой инженерных коммуникаций и монтажом встроенной мебели',
  },
  decorators: InProgress.decorators,
};

/** Грид дашборда: 1 → 2 → 3 колонки по ширине + замыкающая плитка «создать». */
export const Grid: Story = {
  render: () => (
    <CardGrid>
      <ContractTile no="PR-1042" title="Ремонт кухни" status="in_progress" statusLabel="В работе" metaLabel="Анна К. · Вы — заказчик" amountLabel="120 000 ₽" payLabel="Платёж под защитой" onOpen={() => {}} />
      <ContractTile no="PR-1039" title="Логотип для кафе" status="signed" statusLabel="Подписан" metaLabel="Дмитрий В. · Вы — исполнитель" amountLabel="25 000 ₽" payLabel="Эскроу-холд" onOpen={() => {}} />
      <ContractTile no="PR-1051" title="Тексты для лендинга" status="in_progress" statusLabel="В работе" metaLabel="Sofia M. · Вы — исполнитель" amountLabel="18 000 ₽" payLabel="Наличный расчёт" onOpen={() => {}} />
      <CreateContractTile label="Создать договор" onCreate={() => {}} />
    </CardGrid>
  ),
};
