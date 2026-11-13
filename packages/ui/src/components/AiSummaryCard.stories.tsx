import type { Meta, StoryObj } from '@storybook/react';
import { AiSummaryCard } from './AiSummaryCard';

const meta: Meta<typeof AiSummaryCard> = {
  title: 'Компоненты/AiSummaryCard',
  component: AiSummaryCard,
};
export default meta;
type Story = StoryObj<typeof AiSummaryCard>;

const ITEMS = [
  { label: 'Что делаем', value: 'Ремонт кухни «под ключ» · Ремонт' },
  { label: 'Этапы', value: '3 оплачиваемых этапа, приёмка — по чек-листам' },
  { label: 'Сумма', value: '120 000.00 RUB' },
  { label: 'Расчёт', value: 'Платёж под защитой платформы' },
  { label: 'Приёмка', value: 'По мере готовности этапов, с чек-листом и доказательствами' },
];

export const Default: Story = {
  args: {
    badgeLabel: 'резюме',
    title: 'Проверьте перед подписанием',
    items: ITEMS,
    fullTextLabel: 'Читать полный текст договора',
    onFullText: () => {},
    disclaimer: 'AI-резюме не заменяет полный текст договора — сверьтесь с ним перед подписью.',
  },
};
