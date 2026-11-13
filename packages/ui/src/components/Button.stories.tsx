import type { Meta, StoryObj } from '@storybook/react';
import { Button } from './Button';
import { Icon } from './Icon';

const meta: Meta<typeof Button> = {
  title: 'Компоненты/Button',
  component: Button,
  args: { children: 'Ударить по рукам' },
  argTypes: {
    variant: { control: 'select', options: ['primary', 'secondary', 'teal', 'spark', 'ghost', 'destructive'] },
    size: { control: 'inline-radio', options: ['sm', 'md', 'lg'] },
  },
};
export default meta;
type Story = StoryObj<typeof Button>;

export const Primary: Story = { args: { variant: 'primary' } };
export const Secondary: Story = { args: { variant: 'secondary', children: 'Принять работу' } };
export const Teal: Story = { args: { variant: 'teal', children: 'Под защитой' } };
/* Мягкий янтарь на тёмном рейле — «Предложить правку» (замечание владельца 07.09). */
export const Spark: Story = {
  render: () => (
    <div style={{ background: 'var(--pr-grad-ink)', padding: 24, borderRadius: 16 }}>
      <Button variant="spark">Предложить правку</Button>
    </div>
  ),
};
export const Ghost: Story = { args: { variant: 'ghost', children: 'Обсудить' } };
export const Destructive: Story = { args: { variant: 'destructive', children: 'Расторгнуть' } };

export const WithIcon: Story = {
  args: { variant: 'primary', leftIcon: <Icon name="sealed" size={20} />, children: 'По рукам' },
};

export const AllStates: Story = {
  render: () => (
    <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'center' }}>
      <Button variant="primary">Обычная</Button>
      <Button variant="primary" loading>
        Загрузка
      </Button>
      <Button variant="primary" disabled>
        Неактивная
      </Button>
    </div>
  ),
};

export const AllVariants: Story = {
  render: () => (
    <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
      <Button variant="primary">Primary</Button>
      <Button variant="secondary">Secondary</Button>
      <Button variant="teal">Teal</Button>
      <Button variant="spark">Spark</Button>
      <Button variant="ghost">Ghost</Button>
      <Button variant="destructive">Destructive</Button>
    </div>
  ),
};
