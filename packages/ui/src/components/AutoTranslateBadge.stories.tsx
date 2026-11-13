import type { Meta, StoryObj } from '@storybook/react';
import { AutoTranslateBadge } from './AutoTranslateBadge';

const meta: Meta<typeof AutoTranslateBadge> = {
  title: 'Компоненты/AutoTranslateBadge',
  component: AutoTranslateBadge,
};
export default meta;
type Story = StoryObj<typeof AutoTranslateBadge>;

export const Default: Story = {
  args: {
    label: 'автоперевод',
    tooltip: 'Переведено автоматически — может быть неточно',
  },
};
