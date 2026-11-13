import type { Meta, StoryObj } from '@storybook/react';
import { Button } from './Button';
import { ContractPassport } from './ContractPassport';

/** Паспорт сделки (DEV-19 §4) — тёмная карточка липкого рейла карточки договора. */
const meta: Meta<typeof ContractPassport> = {
  title: 'Компоненты/ContractPassport',
  component: ContractPassport,
  parameters: { backgrounds: { default: 'cream' } },
  decorators: [(Story) => <div style={{ maxWidth: 290 }}>{Story()}</div>],
};
export default meta;
type Story = StoryObj<typeof ContractPassport>;

export const InProgress: Story = {
  args: {
    no: 'PR-1042',
    title: 'Ремонт кухни',
    subtitle: 'Услуга с этапами',
    status: 'in_progress',
    statusLabel: 'В работе',
    rows: [
      { label: 'Заказчик', value: 'Анна К.' },
      { label: 'Исполнитель', value: 'вы' },
      { label: 'Способ расчёта', value: 'Платёж под защитой' },
    ],
    sum: { amount: '120000.00', currency: 'RUB' },
    sumNote: '3 из 5 этапов · 80 000 ₽ принято',
  },
  render: (args) => (
    <ContractPassport
      {...args}
      actions={
        <>
          <Button variant="primary" block onClick={() => {}}>
            Открыть приёмку
          </Button>
          <Button variant="secondary" block onClick={() => {}}>
            Экспорт архива
          </Button>
        </>
      }
    />
  ),
};

/** Черновик без этапов: суммы ещё нет — молчать нельзя, пишем это прямо. */
export const DraftWithoutSum: Story = {
  args: {
    no: 'rc-draft',
    title: 'Ремонт крана на кухне',
    subtitle: 'Услуга с этапами',
    status: 'draft',
    statusLabel: 'Черновик',
    rows: [
      { label: 'Заказчик', value: 'вы' },
      { label: 'Исполнитель', value: 'Анна Кузнецова' },
      { label: 'Способ расчёта', value: 'Способ не выбран' },
    ],
    sum: null,
    sumUnsetLabel: 'Сумма не задана',
  },
};

/** Терминальный статус — красный чип обязан остаться читаемым на тёмном. */
export const Terminated: Story = {
  args: {
    no: 'PR-0988',
    title: 'Поклейка обоев',
    status: 'terminated_by_customer',
    statusLabel: 'Расторгнут заказчиком',
    rows: [
      { label: 'Заказчик', value: 'Анна К.' },
      { label: 'Исполнитель', value: 'вы' },
    ],
    sum: { amount: '28500.00', currency: 'RUB' },
  },
};

/** Все тона статуса на тёмной подложке — контрольный лист контраста (Badge on="dark"). */
export const StatusTones: Story = {
  render: () => (
    <div style={{ display: 'grid', gap: 12 }}>
      {(
        [
          ['draft', 'Черновик'],
          ['under_review', 'На согласовании'],
          ['signed', 'Подписан'],
          ['in_progress', 'В работе'],
          ['completed', 'Завершён'],
          ['under_warranty', 'Гарантия активна'],
          ['rejected_by_counterparty', 'Отклонён контрагентом'],
        ] as const
      ).map(([status, label]) => (
        <ContractPassport
          key={status}
          no="PR-1042"
          title="Ремонт кухни"
          status={status}
          statusLabel={label}
          sum={{ amount: '120000.00', currency: 'RUB' }}
        />
      ))}
    </div>
  ),
};
