import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { PeriodFilter, type PeriodFilterValue } from './PeriodFilter';

const LABELS: Record<PeriodFilterValue, string> = {
  day: 'День',
  week: 'Неделя',
  month: 'Месяц',
  halfyear: 'Полгода',
};

const meta: Meta<typeof PeriodFilter> = {
  title: 'Компоненты/PeriodFilter',
  component: PeriodFilter,
};
export default meta;
type Story = StoryObj<typeof PeriodFilter>;

export const Month: Story = {
  args: { value: 'month', labels: LABELS, ariaLabel: 'Период', onChange: () => {} },
};

export const Interactive: Story = {
  render: () => {
    function Harness(): JSX.Element {
      const [value, setValue] = useState<PeriodFilterValue>('month');
      return <PeriodFilter value={value} onChange={setValue} labels={LABELS} ariaLabel="Период" />;
    }
    return <Harness />;
  },
};
