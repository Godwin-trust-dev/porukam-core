import type { Meta, StoryObj } from '@storybook/react';
import { CustomTermsBlock } from './CustomTermsBlock';

const meta: Meta<typeof CustomTermsBlock> = {
  title: 'Компоненты/CustomTermsBlock',
  component: CustomTermsBlock,
};
export default meta;
type Story = StoryObj<typeof CustomTermsBlock>;

export const Default: Story = {
  args: {
    title: 'Текст стороны',
    tag: 'не переводится платформой',
    text: 'Исполнитель разрабатывает лендинг на платформе Tilda по брифу заказчика, включая один блок правок по замечаниям после сдачи.',
    translateCta: 'Перевести (скоро)',
  },
};
