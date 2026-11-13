import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import type { MaterialCatalogItem, UnitOption } from '@porukam/core';
import { StagesBuilder, type StagesBuilderValue } from './StagesBuilder';
import { stagesBuilderLabels } from './__fixtures__/contractNewLabels';

const CATALOG: MaterialCatalogItem[] = [
  { ref: 'cat-tile', title: 'Плитка керамическая', default_unit: 'm2' },
  { ref: 'other', title: 'Прочее' },
];
const UNITS: UnitOption[] = [
  { code: 'pcs', label: 'шт', hint: 'напр. 4 шт' },
  { code: 'm2', label: 'м²', hint: 'напр. 12 м²' },
];

const meta: Meta<typeof StagesBuilder> = {
  title: 'Компоненты/StagesBuilder',
  component: StagesBuilder,
};
export default meta;
type Story = StoryObj<typeof StagesBuilder>;

const EMPTY: StagesBuilderValue = { sections: [], stages: [], totalCost: '' };

export const Empty: Story = {
  args: { value: EMPTY, onChange: () => {}, currency: 'RUB', catalog: CATALOG, units: UNITS, labels: stagesBuilderLabels },
};

const EVEN: StagesBuilderValue = {
  sections: [],
  totalCost: '100.00',
  stages: [
    { id: '1', sectionId: null, title: 'Этап 1', amount: '33.33', auto: true, durationDays: '2', checklist: [], materials: [], advance: null, advancePercent: null },
    { id: '2', sectionId: null, title: 'Этап 2', amount: '33.33', auto: true, durationDays: '3', checklist: [], materials: [], advance: null, advancePercent: null },
    { id: '3', sectionId: null, title: 'Этап 3', amount: '33.34', auto: true, durationDays: '2', checklist: [], materials: [], advance: null, advancePercent: null },
  ],
};

export const AutoDistributed: Story = {
  name: 'Разнесено поровну (100 / 3)',
  args: { value: EVEN, onChange: () => {}, currency: 'RUB', catalog: CATALOG, units: UNITS, labels: stagesBuilderLabels },
};

function Interactive(): JSX.Element {
  const [value, setValue] = useState<StagesBuilderValue>(EMPTY);
  return <StagesBuilder value={value} onChange={setValue} currency="RUB" catalog={CATALOG} units={UNITS} labels={stagesBuilderLabels} />;
}

export const Interactive_: Story = {
  name: 'Интерактивный',
  render: () => <Interactive />,
};
