import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import type { MaterialCatalogItem, UnitOption } from '@porukam/core';
import { MaterialsModal, type MaterialsModalDraftItem } from './MaterialsModal';
import { Button } from './Button';
import { materialsModalLabels } from './__fixtures__/contractNewLabels';

const CATALOG: MaterialCatalogItem[] = [
  { ref: 'cat-tile', title: 'Плитка керамическая', default_unit: 'm2' },
  { ref: 'other', title: 'Прочее' },
];
const UNITS: UnitOption[] = [
  { code: 'pcs', label: 'шт', hint: 'напр. 4 шт' },
  { code: 'm2', label: 'м²', hint: 'напр. 12 м²' },
];

const meta: Meta<typeof MaterialsModal> = {
  title: 'Компоненты/MaterialsModal',
  component: MaterialsModal,
};
export default meta;
type Story = StoryObj<typeof MaterialsModal>;

export const WithItems: Story = {
  args: {
    open: true,
    onClose: () => {},
    catalog: CATALOG,
    units: UNITS,
    currency: 'RUB',
    items: [
      {
        id: '1',
        catalogRef: 'cat-tile',
        title: 'Плитка керамическая',
        quantity: '12',
        unitCode: 'm2',
        deliveryDays: '3',
        deliveryBase: 'contract_signing',
        suppliedBy: 'customer',
        unitPrice: '1200.00',
      },
    ],
    onAdd: () => {},
    onUpdate: () => {},
    onDelete: () => {},
    onDone: () => {},
    labels: materialsModalLabels,
  },
};

function Interactive(): JSX.Element {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<MaterialsModalDraftItem[]>([]);
  return (
    <>
      <Button onClick={() => setOpen(true)}>Материалы ({items.length})</Button>
      <MaterialsModal
        open={open}
        onClose={() => setOpen(false)}
        catalog={CATALOG}
        units={UNITS}
        currency="RUB"
        items={items}
        onAdd={(m) => setItems((it) => [...it, { ...m, id: String(Date.now() + Math.random()) }])}
        onUpdate={(id, m) => setItems((it) => it.map((x) => (x.id === id ? { ...m, id } : x)))}
        onDelete={(id) => setItems((it) => it.filter((x) => x.id !== id))}
        onDone={() => setOpen(false)}
        labels={materialsModalLabels}
      />
    </>
  );
}

export const Interactive_: Story = {
  name: 'Интерактивный',
  render: () => <Interactive />,
};
