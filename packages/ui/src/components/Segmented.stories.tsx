import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { Segmented } from './Segmented';

const meta: Meta<typeof Segmented> = {
  title: 'Компоненты/Segmented',
  component: Segmented,
};
export default meta;
type Story = StoryObj<typeof Segmented>;

function Demo({ narrow, tone }: { narrow?: boolean; tone?: 'light' | 'dark' }): JSX.Element {
  const [role, setRole] = useState<'customer' | 'contractor'>('customer');
  const [acting, setActing] = useState<'person' | 'business'>('person');
  return (
    <div style={{ display: 'grid', gap: 8, maxWidth: narrow ? 300 : 640 }}>
      <Segmented
        ariaLabel="Я в договоре"
        tone={tone}
        value={role}
        onChange={setRole}
        items={[
          { value: 'customer', label: 'Заказчик' },
          { value: 'contractor', label: 'Исполнитель' },
        ]}
      />
      <Segmented
        ariaLabel="Кем выступаю"
        tone={tone}
        value={acting}
        onChange={setActing}
        items={[
          { value: 'person', label: 'Физлицо' },
          { value: 'business', label: 'Бизнес-профиль' },
        ]}
      />
    </div>
  );
}

export const ДваСегмента: Story = {
  parameters: { viewport: { defaultViewport: 'w768' } },
  render: () => <Demo />,
};

/** §6: на узком сегменты переносятся в 2 строки, а не распирают экран. */
export const УзкийЭкран: Story = {
  parameters: { viewport: { defaultViewport: 'w360' } },
  render: () => <Demo narrow />,
};

/** Доска B, мастер создания: чернильная капсула, выбранное — белая пилюля. */
export const ТёмныйТон: Story = {
  parameters: { viewport: { defaultViewport: 'w360' } },
  render: () => <Demo narrow tone="dark" />,
};
