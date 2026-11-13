import type { Meta, StoryObj } from '@storybook/react';
import { ListRow } from './ListRow';
import { Surface } from './Surface';

const meta: Meta<typeof Surface> = {
  title: 'Компоненты/Surface',
  component: Surface,
};
export default meta;
type Story = StoryObj<typeof Surface>;

/** §2: одна поверхность + hairline между строками — НЕ карточка на каждый элемент. */
export const СписокСHairline: Story = {
  parameters: { viewport: { defaultViewport: 'w360' } },
  render: () => (
    <Surface>
      {['Демонтаж', 'Черновые работы', 'Чистовая отделка', 'Электрика'].map((title, i) => (
        <ListRow
          key={title}
          avatarName={title}
          title={title}
          meta={i < 2 ? 'принят' : 'ожидает'}
          amount={`${40 - i * 5} 000 ₽`}
          onOpen={() => {}}
        />
      ))}
    </Surface>
  ),
};

/** `padded` — та же поверхность под НЕ-списочное содержимое (kv-блок, пояснение). */
export const СПаддингом: Story = {
  parameters: { viewport: { defaultViewport: 'w768' } },
  render: () => (
    <Surface padded>
      <p style={{ margin: 0 }}>Деньги уйдут исполнителю только после того, как вы примете этап.</p>
    </Surface>
  ),
};
