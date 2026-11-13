import type { Meta, StoryObj } from '@storybook/react';
import { AmendmentsBlock } from './AmendmentsBlock';

const meta: Meta<typeof AmendmentsBlock> = {
  title: 'Компоненты/AmendmentsBlock',
  component: AmendmentsBlock,
};
export default meta;
type Story = StoryObj<typeof AmendmentsBlock>;

export const Empty: Story = {
  args: {
    amendments: [],
    emptyTitle: 'Допников пока нет',
    emptyText: 'Изменения условий после подписания оформляются отдельным соглашением',
    createLabel: 'Создать допник',
    onCreate: () => {},
  },
};

export const WithList: Story = {
  args: {
    ...Empty.args,
    amendments: [
      { id: 'am-1', title: 'Допник №1 — добавлен этап «Фурнитура»', statusLabel: 'Действует', statusTone: 'green', amountDeltaLabel: '+8 000 ₽', createdAtLabel: '2 авг' },
      { id: 'am-2', title: 'Допник №2 — перенос срока', statusLabel: 'Согласование', statusTone: 'amber', createdAtLabel: '5 авг' },
    ],
    onOpen: () => {},
  },
};
