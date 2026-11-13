import type { Meta, StoryObj } from '@storybook/react';
import { CompareColumns } from './CompareColumns';

const meta: Meta<typeof CompareColumns> = {
  title: 'Компоненты/CompareColumns',
  component: CompareColumns,
  parameters: { layout: 'padded' },
};
export default meta;
type Story = StoryObj<typeof CompareColumns>;

export const Desktop: Story = {
  name: 'desktop — две колонки (DEV-16b §3)',
  args: {
    viewerLabel: 'Ваш язык (автоперевод)',
    viewerText:
      'Это официальная версия договора «Разработка лендинга» (Веб-разработка) на сумму 35000.00 RUB. Он определяет отношения сторон в зафиксированном виде.',
    officialLabel: 'Официальный текст (English)',
    officialText:
      'This is the official version of the agreement "Landing page development" (Web development), total 35000.00 RUB. It governs the relationship between the parties as recorded in this frozen version.',
  },
};
