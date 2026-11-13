import type { Meta, StoryObj } from '@storybook/react';
import { SphereRow } from './SphereRow';

const meta: Meta<typeof SphereRow> = {
  title: 'Компоненты/SphereRow',
  component: SphereRow,
};
export default meta;
type Story = StoryObj<typeof SphereRow>;

/** Строка ИСПОЛНИТЕЛЯ: полоса — «сделано в срок» (ADR-163 §1). Зелёная
 * зона: 141 из 156 — 90 %. */
export const ContractorGreen: Story = {
  args: {
    name: 'Ремонт',
    onTime: { done: 141, total: 156 },
    onTimeLabel: '141 из 156 сделано в срок',
    progressAriaLabel: 'Сделано в срок: 141 из 156',
    firstTimeLabel: '150 из 156 принято с первого раза',
    notes: ['1 спор · решён скидкой', '2 гарантийных обращения'],
  },
};

/** Строка ЗАКАЗЧИКА: полоса — «оплачено в срок». Оранжевая зона (50 %). */
export const CustomerAmber: Story = {
  args: {
    name: 'Сборка мебели',
    onTime: { done: 6, total: 12 },
    onTimeLabel: '6 из 12 оплачено в срок',
    progressAriaLabel: 'Оплачено в срок: 6 из 12',
    firstTimeLabel: '11 из 12 принято с первого раза',
  },
};

/** Красная зона — полоса всё равно только одна на строку. */
export const RedZone: Story = {
  args: {
    name: 'Перевозки',
    onTime: { done: 1, total: 9 },
    onTimeLabel: '1 из 9 сделано в срок',
    progressAriaLabel: 'Сделано в срок: 1 из 9',
  },
};

/** `total: 0` — мерить нечего: полосы нет ВОВСЕ, это не красная зона. */
export const NothingToMeasure: Story = {
  args: {
    name: 'Репетиторство',
    onTime: { done: 0, total: 0 },
    onTimeLabel: '',
    progressAriaLabel: '',
    firstTimeLabel: '3 из 3 принято с первого раза',
  },
};

export const Clickable: Story = {
  args: {
    name: 'Сборка мебели',
    onTime: { done: 37, total: 45 },
    onTimeLabel: '37 из 45 сделано в срок',
    progressAriaLabel: 'Сделано в срок: 37 из 45',
    onClick: () => alert('Заглушка — детализация сферы (P1)'),
  },
};
