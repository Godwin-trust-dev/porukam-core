import type { Meta, StoryObj } from '@storybook/react';
import { CounterSheet } from './CounterSheet';
import { closeLabel } from './__fixtures__/contractNewLabels';

const meta: Meta<typeof CounterSheet> = {
  title: 'Компоненты/CounterSheet',
  component: CounterSheet,
};
export default meta;
type Story = StoryObj<typeof CounterSheet>;

export const Open: Story = {
  args: {
    open: true,
    title: 'Встречная редакция',
    itemLabel: 'Этап 3 · Укладка плитки · сумма',
    onClose: () => {},
    onSubmit: () => {},
    closeLabel,
    cancelLabel: 'Отмена',
    submitLabel: 'Отправить встречную',
    variantValueLabel: 'Новое значение',
    variantNoteLabel: 'Пояснение (необязательно)',
    addVariantLabel: '+ добавить вариант',
    removeVariantLabel: 'Убрать вариант',
    commentLabel: 'Комментарий (необязательно)',
    variantRequiredHint: 'Укажите хотя бы один вариант',
  },
};
