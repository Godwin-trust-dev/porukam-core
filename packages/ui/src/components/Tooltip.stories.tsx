import type { Meta, StoryObj } from '@storybook/react';
import { Tooltip } from './Tooltip';
import { Badge } from './Badge';

const meta: Meta<typeof Tooltip> = {
  title: 'Компоненты/Tooltip',
  component: Tooltip,
};
export default meta;
type Story = StoryObj<typeof Tooltip>;

export const OnBetaBadge: Story = {
  name: 'наведение/лонг-тап на beta-бейдже (DEV-16a §4)',
  render: () => (
    <Tooltip text="Переведено автоматически — может быть неточно">
      <span>
        <Badge tone="amber">авто-перевод</Badge>
      </span>
    </Tooltip>
  ),
};
