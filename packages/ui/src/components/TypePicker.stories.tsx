import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import type { ContractKind } from '@porukam/core';
import { TypePicker, type TypePickerTile } from './TypePicker';
import { typePickerFixtureLabels } from './__fixtures__/contractNewLabels';

const TILES: TypePickerTile[] = [
  { kind: 'service', title: 'Услуга', desc: 'Работа с этапами и приёмкой', icon: 'stages' },
  { kind: 'sale', title: 'Продажа', desc: 'Товар с фото и доставкой', icon: 'wallet' },
  { kind: 'rent_items', title: 'Аренда', desc: 'Вещь или жильё на срок', icon: 'calendar' },
  { kind: 'loan', title: 'Займ', desc: 'Деньги в долг, с процентами или без', icon: 'receipt' },
];

const meta: Meta<typeof TypePicker> = {
  title: 'Компоненты/TypePicker',
  component: TypePicker,
};
export default meta;
type Story = StoryObj<typeof TypePicker>;

export const Default: Story = {
  args: { value: 'service', onChange: () => {}, tiles: TILES, ...typePickerFixtureLabels },
};

export const NotYetSupported: Story = {
  name: 'Недоступный сценарий',
  args: {
    value: null,
    onChange: () => {},
    tiles: [...TILES.slice(0, 3), { kind: 'loan', title: 'Займ', desc: 'Скоро', icon: 'receipt', availableFrom: 'Р2' }],
    ...typePickerFixtureLabels,
  },
};

function Interactive(): JSX.Element {
  const [value, setValue] = useState<ContractKind | null>(null);
  return <TypePicker value={value} onChange={setValue} tiles={TILES} {...typePickerFixtureLabels} />;
}

export const Interactive_: Story = {
  name: 'Интерактивный',
  render: () => <Interactive />,
};
