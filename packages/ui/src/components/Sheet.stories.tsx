import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { Sheet } from './Sheet';
import { Button } from './Button';
import { closeLabel } from './__fixtures__/contractNewLabels';

const meta: Meta<typeof Sheet> = {
  title: 'Компоненты/Sheet',
  component: Sheet,
};
export default meta;
type Story = StoryObj<typeof Sheet>;

export const Open: Story = {
  args: {
    open: true,
    title: 'Единица измерения',
    onClose: () => {},
    closeLabel,
    children: <p>Содержимое окна — форма или список.</p>,
    actions: (
      <>
        <Button variant="ghost">Отмена</Button>
        <Button variant="primary">Готово</Button>
      </>
    ),
  },
};

function Interactive(): JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button onClick={() => setOpen(true)}>Открыть окно</Button>
      <Sheet open={open} title="Материалы" onClose={() => setOpen(false)} closeLabel={closeLabel} actions={<Button onClick={() => setOpen(false)}>Готово</Button>}>
        <p>Мобайл — шторка снизу, десктоп (≥640px) — центрированная модалка.</p>
      </Sheet>
    </>
  );
}

export const Interactive_: Story = {
  name: 'Интерактивный',
  render: () => <Interactive />,
};
