import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import type { ContractKind } from '@porukam/core';
import { TypeForm } from './TypeForm';
import { typeFormLabels } from './__fixtures__/contractNewLabels';

const meta: Meta<typeof TypeForm> = {
  title: 'Компоненты/TypeForm',
  component: TypeForm,
};
export default meta;
type Story = StoryObj<typeof TypeForm>;

export const Service: Story = {
  args: { type: 'service', data: {}, onChange: () => {}, labels: typeFormLabels },
};

export const Sale: Story = {
  args: { type: 'sale', data: { condition: 'used' }, onChange: () => {}, labels: typeFormLabels },
};

export const RentItems: Story = {
  name: 'Аренда · вещь',
  args: { type: 'rent_items', data: { deposit_enabled: true }, onChange: () => {}, labels: typeFormLabels },
};

export const RentHome: Story = {
  name: 'Аренда · жильё',
  args: { type: 'rent_home', data: {}, onChange: () => {}, labels: typeFormLabels },
};

export const Loan: Story = {
  args: { type: 'loan', data: { interest_mode: 'rate', interest_rate: '60' }, onChange: () => {}, labels: typeFormLabels },
};

function Interactive(): JSX.Element {
  const [type, setType] = useState<ContractKind>('rent_items');
  const [data, setData] = useState<Record<string, unknown>>({});
  return (
    <TypeForm
      type={type}
      data={data}
      onChange={(patch) => setData((d) => ({ ...d, ...patch }))}
      onRentKindChange={(k) => setType(k)}
      labels={typeFormLabels}
    />
  );
}

export const Interactive_: Story = {
  name: 'Интерактивный (аренда)',
  render: () => <Interactive />,
};
