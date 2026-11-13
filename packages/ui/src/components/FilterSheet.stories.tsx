import type { Meta, StoryObj } from '@storybook/react';
import { FilterSheet } from './FilterSheet';

const meta: Meta<typeof FilterSheet> = {
  title: 'Компоненты/FilterSheet',
  component: FilterSheet,
};
export default meta;
type Story = StoryObj<typeof FilterSheet>;

export const Open: Story = {
  args: {
    open: true,
    onClose: () => {},
    closeLabel: 'Закрыть',
    title: 'Фильтр',
    roleLabel: 'Роль ▾',
    roleValue: '',
    roleOptions: [
      { value: '', label: 'Роль ▾' },
      { value: 'customer', label: 'Я заказчик' },
      { value: 'contractor', label: 'Я исполнитель' },
    ],
    onRoleChange: () => {},
    statusLabel: 'Статус',
    statusValue: '',
    statusOptions: [{ value: '', label: 'Статус' }],
    onStatusChange: () => {},
    sphereLabel: 'Сфера',
    sphereValue: '',
    sphereOptions: [{ value: '', label: 'Сфера' }],
    onSphereChange: () => {},
    sortLabel: 'Сортировка',
    sortValue: 'updated',
    sortOptions: [
      { value: 'updated', label: 'По обновлению' },
      { value: 'amount', label: 'По сумме' },
      { value: 'deadline', label: 'По дедлайну' },
    ],
    onSortChange: () => {},
    resetLabel: 'Сбросить',
    onReset: () => {},
    applyLabel: 'Выбрать',
  },
};
