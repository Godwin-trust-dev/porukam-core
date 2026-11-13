import type { Meta, StoryObj } from '@storybook/react';
import { ProposeSheet } from './ProposeSheet';
import { closeLabel } from './__fixtures__/contractNewLabels';

const meta: Meta<typeof ProposeSheet> = {
  title: 'Компоненты/ProposeSheet',
  component: ProposeSheet,
};
export default meta;
type Story = StoryObj<typeof ProposeSheet>;

export const Open: Story = {
  args: {
    open: true,
    title: 'Предложить правку',
    itemLabel: 'Этап 3 · Укладка плитки · сумма',
    onClose: () => {},
    onSubmit: () => {},
    closeLabel,
    cancelLabel: 'Отмена',
    submitLabel: 'Предложить',
    variantValueLabel: 'Новое значение',
    variantNoteLabel: 'Пояснение (необязательно)',
    addVariantLabel: '+ добавить вариант',
    removeVariantLabel: 'Убрать вариант',
    commentLabel: 'Комментарий (необязательно)',
    variantRequiredHint: 'Укажите хотя бы один вариант',
  },
};

export const Submitting: Story = {
  args: { ...Open.args, submitting: true },
};

export const WithError: Story = {
  args: { ...Open.args, error: 'Не удалось отправить правку — попробуйте ещё раз' },
};
