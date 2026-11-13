import type { Meta, StoryObj } from '@storybook/react';
import { Density } from './Density';
import { ContractStatus } from './ContractStatus';
import { EmptyState } from './States';
import { ListRow } from './ListRow';
import { Surface } from './Surface';

const meta: Meta<typeof Density> = {
  title: 'Основы/Density',
  component: Density,
};
export default meta;
type Story = StoryObj<typeof Density>;

function Sample(): JSX.Element {
  return (
    <Surface>
      {['Ремонт кухни', 'Логотип для кафе', 'Аренда квартиры'].map((title) => (
        <ListRow
          key={title}
          avatarName={title}
          title={title}
          meta="Анна Ковалёва · вы исполнитель"
          status={<ContractStatus status="in_progress" label="в работе" appearance="word" />}
          amount="120 000 ₽"
          onOpen={() => {}}
        />
      ))}
    </Surface>
  );
}

/**
 * DEV-20 §1/§7: рабочие экраны идут в `compact` (значение по умолчанию,
 * оборачивать не нужно), якоря — вход, подписание, церемония приёмки — в
 * `cozy`. Разница видна на одном и том же содержимом.
 */
export const КомпактИVsКози: Story = {
  parameters: { viewport: { defaultViewport: 'w768' } },
  render: () => (
    <div style={{ display: 'grid', gap: 24 }}>
      <section>
        <p className="pr-eyebrow">compact — рабочие экраны</p>
        <Sample />
      </section>
      <Density mode="cozy">
        <p className="pr-eyebrow">cozy — якоря (§7)</p>
        <Sample />
      </Density>
    </div>
  ),
};

/** §9: пустое состояние — компактным блоком по центру, тем же ритмом. */
export const ПустоеСостояниеВКомпакте: Story = {
  parameters: { viewport: { defaultViewport: 'w360' } },
  render: () => (
    <EmptyState
      icon="deals"
      title="Активных сделок нет"
      text="Создайте договор — этапы, приёмка по чек-листу и платёж под защитой появятся сами."
      actionLabel="Создать договор"
      onAction={() => {}}
    />
  ),
};
