import type { Meta, StoryObj } from '@storybook/react';
import { ContractListRow } from './ContractListRow';

const meta: Meta<typeof ContractListRow> = {
  title: 'Компоненты/ContractListRow',
  component: ContractListRow,
};
export default meta;
type Story = StoryObj<typeof ContractListRow>;

const actions = [
  { key: 'open', label: 'Открыть', onSelect: () => {} },
  { key: 'archive', label: 'Экспортировать архив', onSelect: () => {} },
  { key: 'repeat', label: 'Как в прошлый раз', onSelect: () => {} },
];

const base = {
  onOpenCounterparty: () => {},
  onOpen: () => {},
  actions,
  actionsTriggerLabel: 'Действия',
  actionsSheetCloseLabel: 'Закрыть',
};

export const ActiveWithAttention: Story = {
  args: {
    ...base,
    title: 'Ремонт кухни, 12 м²',
    sphereLabel: 'Ремонт',
    counterpartyName: 'Мастер Ремонт',
    viewerRoleLabel: 'Вы — заказчик',
    status: 'in_progress',
    statusLabel: 'В работе',
    amountLabel: '120 000 ₽',
    payLabel: 'СБП',
    nextLabel: 'Этап до 14 авг',
    attentionLabel: 'Сдать этап 3',
    progress: { done: 2, total: 5, label: '2 из 5' },
  },
};

export const ArchiveCompleted: Story = {
  args: {
    ...base,
    title: 'Ремонт ванной, 6 м²',
    sphereLabel: 'Ремонт',
    counterpartyName: 'Николай Гром',
    viewerRoleLabel: 'Вы — исполнитель',
    status: 'completed',
    statusLabel: 'Завершён',
    amountLabel: '96 000 ₽',
    payLabel: 'Безналичный расчёт',
    nextLabel: 'Закрыт 2 авг',
  },
};

export const ArchiveMuted: Story = {
  args: {
    ...base,
    title: 'Сборка стеллажа',
    sphereLabel: 'Сборка мебели',
    counterpartyName: 'Ирина Соколова',
    viewerRoleLabel: 'Вы — заказчик',
    status: 'withdrawn_by_initiator',
    statusLabel: 'Отозван инициатором',
    amountLabel: '15 000 ₽',
    payLabel: 'Наличный расчёт',
    nextLabel: 'Не заключён 9 авг',
    muted: true,
  },
};

export const Draft: Story = {
  args: {
    ...base,
    title: 'Установка розеток',
    sphereLabel: 'Электрика',
    counterpartyName: '—',
    viewerRoleLabel: 'Вы — заказчик',
    status: 'draft',
    statusLabel: 'Черновик',
    amountLabel: '0 ₽',
    payLabel: 'Наличный расчёт',
    draftStepLabel: 'Остановились на шаге «Этапы»',
    actions: [
      { key: 'continue', label: 'Продолжить', onSelect: () => {} },
      { key: 'delete', label: 'Удалить', destructive: true, onSelect: () => {} },
    ],
  },
};

/**
 * Выбранная строка master-detail (DEV-19 §2): её карточка открыта в колонке
 * деталей справа. Состояние есть только на десктопе — на узком экране выбора
 * нет, тап уводит на страницу карточки.
 */
export const SelectedInMasterDetail: Story = {
  args: {
    ...base,
    title: 'Ремонт кухни',
    sphereLabel: 'Услуга с этапами',
    counterpartyName: 'Анна Кузнецова',
    viewerRoleLabel: 'Вы — заказчик',
    status: 'in_progress',
    statusLabel: 'В работе',
    amountLabel: '120 000 ₽',
    payLabel: 'Платёж под защитой',
    selected: true,
  },
  decorators: [(Story) => <div style={{ maxWidth: 360 }}>{Story()}</div>],
};
