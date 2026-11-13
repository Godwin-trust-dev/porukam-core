import type { Meta, StoryObj } from '@storybook/react';
import { Button } from './Button';
import { Icon } from './Icon';
import { PassportHeader } from './PassportHeader';

const meta: Meta<typeof PassportHeader> = {
  title: 'Компоненты/PassportHeader',
  component: PassportHeader,
};
export default meta;
type Story = StoryObj<typeof PassportHeader>;

const actions = (
  <>
    <Button variant="primary">Написать</Button>
    <Button variant="ghost">Предложить сделку</Button>
  </>
);

export const OnInk: Story = {
  args: {
    surface: 'on-ink',
    name: 'Артём Ковалёв',
    handle: '@akovalev',
    verification: 'id',
    verificationLabel: 'Личность подтверждена',
    city: 'Москва',
    remote: true,
    remoteLabel: 'Из любого города',
    actions,
  },
  parameters: { backgrounds: { default: 'ink (dark UI)' } },
};

export const Light: Story = {
  args: {
    surface: 'light',
    name: 'Артём Ковалёв',
    handle: '@akovalev',
    verification: 'phone',
    verificationLabel: 'Телефон подтверждён',
    city: 'Москва',
    actions,
  },
};

export const NotVerifiedNoAvatar: Story = {
  args: {
    surface: 'on-ink',
    handle: '@newuser',
    verification: 'none',
    verificationLabel: 'Не подтверждён',
    actions: <Button variant="ghost" leftIcon={<Icon name="share" size={16} />}>Поделиться</Button>,
  },
  parameters: { backgrounds: { default: 'ink (dark UI)' } },
};
