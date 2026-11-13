import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import type { MoneyLike } from '@porukam/core';
import { PaymentModal } from './PaymentModal';
import { Button } from './Button';
import { paymentModalLabels } from './__fixtures__/contractNewLabels';

const AMOUNT: MoneyLike = { amount: '20000.00', currency: 'RUB' };

const meta: Meta<typeof PaymentModal> = {
  title: 'Компоненты/PaymentModal',
  component: PaymentModal,
};
export default meta;
type Story = StoryObj<typeof PaymentModal>;

export const Empty: Story = {
  args: { open: true, onClose: () => {}, amount: AMOUNT, advance: null, advancePercent: null, onChange: () => {}, onDone: () => {}, labels: paymentModalLabels },
};

export const ThirtyPercent: Story = {
  name: '30% аванс',
  args: {
    open: true,
    onClose: () => {},
    amount: AMOUNT,
    advance: { amount: '6000.00', currency: 'RUB' },
    advancePercent: 30,
    onChange: () => {},
    onDone: () => {},
    labels: paymentModalLabels,
  },
};

function Interactive(): JSX.Element {
  const [open, setOpen] = useState(false);
  const [advance, setAdvance] = useState<MoneyLike | null>(null);
  const [percent, setPercent] = useState<number | null>(null);
  return (
    <>
      <Button onClick={() => setOpen(true)}>Оплата этапа</Button>
      <PaymentModal
        open={open}
        onClose={() => setOpen(false)}
        amount={AMOUNT}
        advance={advance}
        advancePercent={percent}
        onChange={(a, p) => {
          setAdvance(a);
          setPercent(p);
        }}
        onDone={() => setOpen(false)}
        labels={paymentModalLabels}
      />
    </>
  );
}

export const Interactive_: Story = {
  name: 'Интерактивный',
  render: () => <Interactive />,
};
