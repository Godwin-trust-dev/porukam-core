import type { Meta, StoryObj } from '@storybook/react';
import { AcceptAllModal } from './AcceptAllModal';
import { closeLabel } from './__fixtures__/contractNewLabels';

const meta: Meta<typeof AcceptAllModal> = {
  title: 'Компоненты/AcceptAllModal',
  component: AcceptAllModal,
};
export default meta;
type Story = StoryObj<typeof AcceptAllModal>;

export const Open: Story = {
  args: {
    open: true,
    title: 'Подтвердите раскладку правок',
    text: 'Есть финансово значимые изменения — просмотрите «было → стало» перед принятием.',
    onClose: () => {},
    closeLabel,
    cancelLabel: 'Отмена',
    confirmLabel: 'Подтвердить и принять все',
    onConfirm: () => {},
    changes: [
      { id: 'rev-1', itemLabel: 'Этап 1 · Демонтаж · сумма', fromValue: '20 000 ₽', toValue: '22 000 ₽' },
      { id: 'rev-2', itemLabel: 'Гарантия', fromValue: '12 мес.', toValue: '18 мес.' },
    ],
    totalBeforeLabel: 'Сумма сейчас',
    totalBefore: '120 000 ₽',
    totalAfterLabel: 'Сумма после',
    totalAfter: '122 000 ₽',
    excludedHint: 'Многовариантные правки выбираются отдельно — в этот список не входят.',
  },
};
