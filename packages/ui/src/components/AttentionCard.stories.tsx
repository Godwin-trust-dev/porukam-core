import type { Meta, StoryObj } from '@storybook/react';
import { AttentionCard } from './AttentionCard';

const meta: Meta<typeof AttentionCard> = {
  title: 'Компоненты/AttentionCard',
  component: AttentionCard,
};
export default meta;
type Story = StoryObj<typeof AttentionCard>;

export const AcceptanceTimer: Story = {
  args: {
    side: 'customer',
    sideLabel: 'Заказчик',
    urgency: { kind: 'timer', value: '1 ч 40 мин' },
    title: 'Укладка ламината, 42 м² — ждёт приёмки',
    action: { label: 'Открыть приёмку' },
    onAction: () => {},
  },
};

/**
 * Строка «Требует внимания» как её видит телефон (решение 09.09): чип рода и
 * таймер сверху, короткое название снизу, короткая кнопка справа. Смотреть в
 * viewport ≤ 599px — правила живут в media-запросе.
 */
export const MobileRow: Story = {
  args: {
    side: 'customer',
    sideLabel: 'Заказчик',
    kindLabel: 'Приёмка',
    kindTone: 'amber',
    urgency: { kind: 'deadline', value: '2 д 1 ч' },
    title: 'Укладка ламината, 42 м² — ждёт приёмки',
    shortTitle: 'Укладка ламината, 42 м²',
    action: { label: 'Открыть приёмку', shortLabel: 'Открыть' },
    onAction: () => {},
  },
  parameters: { viewport: { defaultViewport: 'mobile1' } },
};

export const PaymentAmount: Story = {
  args: {
    side: 'customer',
    sideLabel: 'Заказчик',
    urgency: { kind: 'amount', value: '28 500 ₽' },
    title: 'Поклейка обоев — ожидает оплаты',
    action: { label: 'Оплатить' },
    onAction: () => {},
  },
};

export const DisputeDeadline: Story = {
  args: {
    side: 'contractor',
    sideLabel: 'Исполнитель',
    urgency: { kind: 'deadline', value: '5 дн 0 ч' },
    title: 'Штукатурка стен под покраску — спор',
    action: { label: 'Открыть спор', variant: 'ghost' },
    onAction: () => {},
  },
};

export const InfoMode: Story = {
  args: {
    side: 'contractor',
    sideLabel: 'Исполнитель',
    title: 'Этап «Демонтаж» — ждёт приёмки заказчиком',
    info: {
      text: 'Заказчик принимает этап — вы сдали его вовремя',
      note: 'Осталось 1 ч 40 мин до автоприёмки',
      secondaryAction: { label: 'Напомнить', onAction: () => {} },
    },
  },
};

export const Row: Story = {
  render: () => (
    <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
      <AttentionCard
        side="customer"
        sideLabel="Заказчик"
        urgency={{ kind: 'timer', value: '1 ч 40 мин' }}
        title="Укладка ламината, 42 м² — ждёт приёмки"
        action={{ label: 'Открыть приёмку' }}
        onAction={() => {}}
      />
      <AttentionCard
        side="customer"
        sideLabel="Заказчик"
        urgency={{ kind: 'amount', value: '28 500 ₽' }}
        title="Поклейка обоев — ожидает оплаты"
        action={{ label: 'Оплатить' }}
        onAction={() => {}}
      />
      <AttentionCard
        side="contractor"
        sideLabel="Исполнитель"
        urgency={{ kind: 'deadline', value: '5 дн 0 ч' }}
        title="Штукатурка стен под покраску — спор"
        action={{ label: 'Открыть спор', variant: 'ghost' }}
        onAction={() => {}}
      />
    </div>
  ),
};
