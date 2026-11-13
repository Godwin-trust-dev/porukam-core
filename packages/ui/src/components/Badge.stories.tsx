import type { Meta, StoryObj } from '@storybook/react';
import { Badge } from './Badge';
import { Icon } from './Icon';

const meta: Meta<typeof Badge> = {
  title: 'Компоненты/Badge',
  component: Badge,
};
export default meta;
type Story = StoryObj<typeof Badge>;

export const VerificationLevels: Story = {
  render: () => (
    <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
      <Badge tone="neutral" dot>
        Не верифицирован
      </Badge>
      <Badge tone="teal" dot>
        Телефон подтверждён
      </Badge>
      <Badge tone="green" icon={<Icon name="verified" size={16} />}>
        Личность подтверждена
      </Badge>
    </div>
  ),
};

export const PaymentProtection: Story = {
  render: () => (
    <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
      <Badge tone="teal">Платёж под защитой</Badge>
      <Badge tone="neutral">Без защиты платежа</Badge>
    </div>
  ),
};

export const Segments: Story = {
  render: () => (
    <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
      <Badge tone="ink">Между людьми</Badge>
      <Badge tone="ink">С бизнесом</Badge>
      <Badge tone="amber">Согласование</Badge>
      <Badge tone="green">Завершён</Badge>
      <Badge tone="red">Спор</Badge>
    </div>
  ),
};

/**
 * На тёмной подложке (паспорт-рейл карточки, DEV-19 §4) заливка становится
 * непрозрачно-светлой, а тон остаётся цветом текста: контраст держится, новых
 * цветов в палитру не добавлено.
 */
export const OnDark: Story = {
  parameters: { backgrounds: { default: 'ink (dark UI)' } },
  render: () => (
    <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', padding: 16 }}>
      <Badge tone="neutral" on="dark" dot>
        Черновик
      </Badge>
      <Badge tone="amber" on="dark" dot>
        В работе
      </Badge>
      <Badge tone="green" on="dark" dot>
        Завершён
      </Badge>
      <Badge tone="teal" on="dark" dot>
        Гарантия активна
      </Badge>
      <Badge tone="red" on="dark" dot>
        Расторгнут заказчиком
      </Badge>
      <Badge tone="ink" on="dark">
        Между людьми
      </Badge>
    </div>
  ),
};
