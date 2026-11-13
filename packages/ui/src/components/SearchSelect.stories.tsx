import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { SearchSelect, type SearchSelectOption } from './SearchSelect';

const meta: Meta<typeof SearchSelect> = {
  title: 'Компоненты/SearchSelect',
  component: SearchSelect,
};
export default meta;
type Story = StoryObj<typeof SearchSelect>;

/** Каталог материалов: плоский список без секций. */
const CATALOG: SearchSelectOption[] = [
  { value: 'cat-tile', label: 'Плитка керамическая' },
  { value: 'cat-laminate', label: 'Ламинат' },
  { value: 'cat-glue', label: 'Клей плиточный' },
  { value: 'cat-grout', label: 'Затирка для швов' },
  { value: 'cat-primer', label: 'Грунтовка глубокого проникновения' },
  { value: 'cat-drywall', label: 'Гипсокартон' },
  { value: 'other_renovation', label: 'Прочее' },
];

/** «Что меняем» в правке: секции разделов договора, серым — текущее значение. */
const REVISION: SearchSelectOption[] = [
  { value: 'title', label: 'Название договора', hint: 'Ремонт ванной комнаты', group: 'Условия' },
  { value: 'payment.method', label: 'Способ расчёта', hint: 'Наличными', group: 'Оплаты' },
  { value: 'payment.order', label: 'Порядок оплаты', hint: 'После приёмки', group: 'Оплаты' },
  { value: 'milestone.ms-1.title', label: 'Демонтаж - Название', hint: 'Демонтаж', group: 'Этапы' },
  { value: 'milestone.ms-1.amount', label: 'Демонтаж - Сумма', hint: '20 000 ₽', group: 'Этапы' },
  { value: 'milestone.ms-2.amount', label: 'Укладка плитки - Сумма', hint: '60 000 ₽', group: 'Этапы' },
  { value: 'material.mt-1.quantity', label: 'Плитка керамическая - Количество', hint: '12 м2', group: 'Материалы' },
  { value: 'other', label: 'Другое (своё условие)' },
];

function Interactive({ options, initial = '' }: { options: SearchSelectOption[]; initial?: string }): JSX.Element {
  const [value, setValue] = useState(initial);
  return (
    <div style={{ maxWidth: 420 }}>
      <SearchSelect
        label="Тип материала"
        value={value}
        onChange={setValue}
        options={options}
        placeholder="Начните вводить название"
        noMatchText="Не нашли? Выберите «Прочее» и впишите название"
        data-testid="story-search-select"
      />
    </div>
  );
}

export const Catalog: Story = {
  render: () => <Interactive options={CATALOG} initial="cat-tile" />,
};

export const Grouped: Story = {
  render: () => <Interactive options={REVISION} />,
};

export const Disabled: Story = {
  args: {
    label: 'Тип материала',
    value: 'cat-tile',
    onChange: () => {},
    options: CATALOG,
    disabled: true,
  },
};
