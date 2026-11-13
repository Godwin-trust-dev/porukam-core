import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { CurrencyField } from './CurrencyField';
import { currencyFieldLabel } from './__fixtures__/contractNewLabels';

const meta: Meta<typeof CurrencyField> = {
  title: 'Компоненты/CurrencyField',
  component: CurrencyField,
};
export default meta;
type Story = StoryObj<typeof CurrencyField>;

export const Default: Story = {
  args: { value: 'RUB', options: ['RUB', 'USD', 'EUR'], onChange: () => {}, label: currencyFieldLabel },
};

function Interactive(): JSX.Element {
  const [value, setValue] = useState('RUB');
  return <CurrencyField value={value} options={['RUB', 'USD', 'EUR']} onChange={setValue} label={currencyFieldLabel} hint="Меняет валюту всех сумм договора" />;
}

export const Interactive_: Story = {
  name: 'Интерактивный',
  render: () => <Interactive />,
};
