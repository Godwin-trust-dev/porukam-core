import type { Meta, StoryObj } from '@storybook/react';
import { ContractListRow } from './ContractListRow';
import { EmptyState } from './States';
import { ScreenTabs } from './ScreenTabs';

/**
 * Витрина композиции DEV-13 (не отдельный экспортируемый компонент — сама страница
 * `ContractsListPage.tsx` живёт в `web/`, Storybook её не видит): вкладки + список строк
 * в desktop-раскладке (§9 «таблица-подобный список»).
 */
function DesktopTable(): JSX.Element {
  const actions = [
    { key: 'open', label: 'Открыть', onSelect: () => {} },
    { key: 'archive', label: 'Экспортировать архив', onSelect: () => {} },
    { key: 'repeat', label: 'Как в прошлый раз', onSelect: () => {} },
  ];
  const shared = { onOpenCounterparty: () => {}, onOpen: () => {}, actions, actionsTriggerLabel: 'Действия', actionsSheetCloseLabel: 'Закрыть' };
  return (
    <div style={{ maxWidth: 900, display: 'grid', gap: 'var(--pr-sp-5)' }}>
      <ScreenTabs
        items={[
          { key: 'active', label: 'Активные', count: 12 },
          { key: 'archive', label: 'Архив', count: 5 },
        ]}
        active="active"
        onChange={() => {}}
        ariaLabel="Мои договоры"
        onOpenFilters={() => {}}
        filtersLabel="Фильтр"
      />
      <div style={{ display: 'grid', gap: 'var(--pr-sp-3)' }}>
        <ContractListRow
          {...shared}
          title="Ремонт кухни, 12 м²"
          sphereLabel="Ремонт"
          counterpartyName="Мастер Ремонт"
          viewerRoleLabel="Вы — заказчик"
          status="in_progress"
          statusLabel="В работе"
          amountLabel="120 000 ₽"
          payLabel="СБП"
          nextLabel="Этап до 14 авг"
          attentionLabel="Сдать этап 3"
          progress={{ done: 2, total: 5, label: '2 из 5' }}
        />
        <ContractListRow
          {...shared}
          title="Поклейка обоев, три комнаты"
          sphereLabel="Ремонт"
          counterpartyName="Николай Гром"
          viewerRoleLabel="Вы — исполнитель"
          status="awaiting_signatures"
          statusLabel="Ждём подписи"
          amountLabel="34 000 ₽"
          payLabel="Наличный расчёт"
          nextLabel="Ждём подписи"
        />
        <ContractListRow
          {...shared}
          title="Перевозка мебели"
          sphereLabel="Переезды"
          counterpartyName="Анна Свет"
          viewerRoleLabel="Вы — заказчик"
          status="suspended"
          statusLabel="Приостановлен"
          amountLabel="18 000 ₽"
          payLabel="Наличный расчёт"
          nextLabel="Ждём материалы"
          progress={{ done: 1, total: 3, label: '1 из 3' }}
        />
      </div>
    </div>
  );
}

const meta: Meta<typeof DesktopTable> = {
  title: 'Компоненты/ContractsListShowcase',
  component: DesktopTable,
};
export default meta;
type Story = StoryObj<typeof DesktopTable>;

export const DesktopTableView: Story = { args: {} };

export const EmptySearch: StoryObj<typeof EmptyState> = {
  render: () => (
    <EmptyState icon="search" title="Ничего не найдено" text="Попробуйте изменить запрос или сбросить фильтры." actionLabel="Сбросить фильтры" onAction={() => {}} />
  ),
};

export const EmptyFirst: StoryObj<typeof EmptyState> = {
  render: () => (
    <EmptyState
      icon="deals"
      title="Пока нет активных договоров"
      text="Создайте договор или найдите исполнителя — здесь появятся ваши сделки в работе."
      actionLabel="Создать договор"
      onAction={() => {}}
    />
  ),
};
