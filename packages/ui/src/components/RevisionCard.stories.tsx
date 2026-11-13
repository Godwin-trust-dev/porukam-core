import type { Meta, StoryObj } from '@storybook/react';
import { RevisionCard } from './RevisionCard';

const meta: Meta<typeof RevisionCard> = {
  title: 'Компоненты/RevisionCard',
  component: RevisionCard,
};
export default meta;
type Story = StoryObj<typeof RevisionCard>;

const variants = [
  { id: 'v1', label: '60 000 ₽' },
  { id: 'v2', label: '65 000 ₽', note: 'с доставкой материала' },
];

export const CounterpartyMultiVariant: Story = {
  name: 'Чужая · мультивариант (ваш ход)',
  args: {
    itemLabel: 'Этап 3 · Укладка плитки · сумма',
    fromLabel: 'Было',
    fromValue: '50 000 ₽',
    variants,
    ariaLabel: 'Варианты по пункту «Этап 3 · Укладка плитки»',
    pickLabel: 'Выбрать',
    statusLabel: 'открыта',
    statusTone: 'amber',
    isMine: false,
    open: true,
    onPick: () => {},
    rejectLabel: 'Отклонить',
    onReject: () => {},
    counterLabel: 'Встречная',
    onCounter: () => {},
  },
};

export const MineWaiting: Story = {
  name: 'Своя · мультивариант (ожидает)',
  args: {
    ...CounterpartyMultiVariant.args,
    isMine: true,
    waitingLabel: 'Ожидает выбора контрагента',
    withdrawLabel: 'Отозвать',
    onWithdraw: () => {},
  },
};

export const FinanciallyMaterial: Story = {
  args: {
    ...CounterpartyMultiVariant.args,
    financiallyMaterialLabel: 'Финансово значимая правка',
    comment: 'Плитка подорожала у поставщика',
  },
};

export const Accepted: Story = {
  args: {
    ...CounterpartyMultiVariant.args,
    open: false,
    statusLabel: 'принята',
    statusTone: 'green',
    chosenVariantId: 'v1',
  },
};
