import type { Meta, StoryObj } from '@storybook/react';
import { AcceptanceChecklist } from './AcceptanceChecklist';

const meta: Meta<typeof AcceptanceChecklist> = {
  title: 'Компоненты/AcceptanceChecklist',
  component: AcceptanceChecklist,
};
export default meta;
type Story = StoryObj<typeof AcceptanceChecklist>;

export const Empty: Story = {
  args: {
    items: [
      { id: 'a', label: 'Плитка уложена по всей площади', optional: false },
      { id: 'b', label: 'Швы затёрты', optional: false },
      { id: 'c', label: 'Мусор и упаковка вывезены', optional: true, optionalLabel: 'необязательно' },
    ],
    attachLabel: '+ Приложить',
    onAttach: () => {},
  },
};

export const WithEvidence: Story = {
  args: {
    items: [
      { id: 'a', label: 'Плитка уложена по всей площади', optional: false, attachedLabel: 'приложено · 1' },
      { id: 'b', label: 'Швы затёрты', optional: false, attachedLabel: 'приложено · 2' },
      { id: 'c', label: 'Мусор и упаковка вывезены', optional: true, optionalLabel: 'необязательно' },
    ],
    attachLabel: '+ Приложить',
    onAttach: () => {},
  },
};
