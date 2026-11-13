import type { Meta, StoryObj } from '@storybook/react';
import { EditContractLink } from './EditContractLink';

const meta: Meta<typeof EditContractLink> = {
  title: 'Компоненты/EditContractLink',
  component: EditContractLink,
};
export default meta;
type Story = StoryObj<typeof EditContractLink>;

export const Enabled: Story = {
  args: {
    label: 'Редактировать договор',
    warning: 'Изменить условия уже подписанного договора можно только через дополнительное соглашение',
    enabled: true,
    onEdit: () => {},
  },
};

export const Disabled: Story = {
  args: {
    label: 'Редактировать договор',
    warning: 'Изменить условия уже подписанного договора можно только через дополнительное соглашение',
    enabled: false,
    onEdit: () => {},
  },
};
