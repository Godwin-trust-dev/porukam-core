import type { Meta, StoryObj } from '@storybook/react';
import { SearchInput } from './SearchInput';

const meta: Meta<typeof SearchInput> = {
  title: 'Компоненты/SearchInput',
  component: SearchInput,
};
export default meta;
type Story = StoryObj<typeof SearchInput>;

export const Empty: Story = { args: { value: '', onChange: () => {}, placeholder: 'Контрагент, название, №', clearLabel: 'Очистить поиск' } };
export const WithValue: Story = { args: { value: 'кухня', onChange: () => {}, placeholder: 'Контрагент, название, №', clearLabel: 'Очистить поиск' } };
