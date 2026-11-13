import type { Meta, StoryObj } from '@storybook/react';
import { Button } from './Button';
import { ScreenHeader } from './ScreenHeader';

const meta: Meta<typeof ScreenHeader> = {
  title: 'Компоненты/ScreenHeader',
  component: ScreenHeader,
};
export default meta;
type Story = StoryObj<typeof ScreenHeader>;

/** §4: заголовок 16–18 + действие справа. Большого амбер-пилла нет. */
export const СДействием: Story = {
  parameters: { viewport: { defaultViewport: 'w360' } },
  args: {
    title: 'Сделки',
    actions: (
      <Button variant="primary" size="sm">
        Создать
      </Button>
    ),
  },
};

export const СПодписью: Story = {
  parameters: { viewport: { defaultViewport: 'w768' } },
  args: {
    title: 'Экспорт архива',
    subtitle: 'Ремонт кухни · снимок на 18.08',
  },
};
