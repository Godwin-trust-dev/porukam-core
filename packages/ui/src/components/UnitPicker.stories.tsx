import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import type { UnitOption } from '@porukam/core';
import { UnitPicker } from './UnitPicker';
import { Button } from './Button';
import { unitPickerFixtureLabels } from './__fixtures__/contractNewLabels';

const UNITS: UnitOption[] = [
  { code: 'pcs', label: 'шт', hint: 'напр. 4 шт' },
  { code: 'm2', label: 'м²', hint: 'напр. 12 м²' },
  { code: 'kg', label: 'кг', hint: 'напр. 25 кг' },
];

const meta: Meta<typeof UnitPicker> = {
  title: 'Компоненты/UnitPicker',
  component: UnitPicker,
};
export default meta;
type Story = StoryObj<typeof UnitPicker>;

export const Open: Story = {
  args: { open: true, onClose: () => {}, units: UNITS, value: 'm2', onPick: () => {}, ...unitPickerFixtureLabels },
};

function Interactive(): JSX.Element {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState('m2');
  return (
    <>
      <Button onClick={() => setOpen(true)}>Выбрать единицу ({value})</Button>
      <UnitPicker open={open} onClose={() => setOpen(false)} units={UNITS} value={value} onPick={(u) => setValue(u.code)} {...unitPickerFixtureLabels} />
    </>
  );
}

export const Interactive_: Story = {
  name: 'Интерактивный',
  render: () => <Interactive />,
};
