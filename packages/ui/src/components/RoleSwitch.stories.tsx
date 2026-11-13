import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { RoleSwitch, type ReputationRoleValue } from './RoleSwitch';

const meta: Meta<typeof RoleSwitch> = {
  title: 'Компоненты/RoleSwitch',
  component: RoleSwitch,
};
export default meta;
type Story = StoryObj<typeof RoleSwitch>;

export const Interactive: Story = {
  render: () => {
    function Demo(): JSX.Element {
      const [value, setValue] = useState<ReputationRoleValue>('contractor');
      return (
        <RoleSwitch
          value={value}
          onChange={setValue}
          contractorLabel="Исполнитель"
          customerLabel="Заказчик"
          ariaLabel="Роль в репутации"
        />
      );
    }
    return <Demo />;
  },
};

export const CustomerActive: Story = {
  args: {
    value: 'customer',
    contractorLabel: 'Исполнитель',
    customerLabel: 'Заказчик',
    ariaLabel: 'Роль в репутации',
    onChange: () => {},
  },
};
