import type { Meta, StoryObj } from '@storybook/react';
import { ContractCardSkeleton, EmptyState, ErrorState, Skeleton } from './States';

const meta: Meta = {
  title: 'Компоненты/Состояния экрана',
};
export default meta;
type Story = StoryObj;

export const Loading: Story = {
  render: () => (
    <div style={{ display: 'grid', gap: 16, maxWidth: 420 }}>
      <Skeleton width="70%" height={22} />
      <ContractCardSkeleton />
      <ContractCardSkeleton />
    </div>
  ),
};

export const Empty: Story = {
  render: () => (
    <EmptyState
      icon="deals"
      title="Пока нет сделок"
      text="Здесь появятся ваши договоры — с этапами, оплатой и приёмкой."
      actionLabel="Создать договор"
      actionDisabled
      actionHint="Договорный контур появится в следующем этапе разработки"
    />
  ),
};

/** DEV-17 §3: primary + вторичное ghost-действие — единый компактный блок. */
export const EmptyWithSecondaryAction: Story = {
  render: () => (
    <EmptyState
      icon="deals"
      title="Пока нет сделок"
      text="Здесь появятся ваши договоры — с этапами, оплатой и приёмкой."
      actionLabel="Создать договор"
      secondaryActionLabel="Найти исполнителя"
    />
  ),
};

export const Error: Story = {
  render: () => (
    <ErrorState title="Не удалось загрузить сделки." code="rate_limited" retryLabel="Повторить" />
  ),
};
