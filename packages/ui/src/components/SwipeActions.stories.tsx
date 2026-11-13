import type { Meta, StoryObj } from '@storybook/react';
import { ListRow } from './ListRow';
import { SwipeActions } from './SwipeActions';
import { Surface } from './Surface';

const meta: Meta<typeof SwipeActions> = {
  title: 'Компоненты/SwipeActions',
  component: SwipeActions,
};
export default meta;
type Story = StoryObj<typeof SwipeActions>;

const ACTIONS = [
  { key: 'open', label: 'Открыть', onSelect: () => {} },
  { key: 'copy', label: 'Как в прошлый раз', quick: true, onSelect: () => {} },
  { key: 'archive', label: 'Экспортировать архив', quick: true, onSelect: () => {} },
  { key: 'delete', label: 'Удалить', destructive: true, onSelect: () => {} },
];

/**
 * Свайп-действия строки (DEV-20_2 §2) — вместо «⋯» в строке. Свайп по строке
 * открывает быстрые (`quick`), долгий тап — полный список в шите. Клавиатурой
 * тот же список достаётся скрытой кнопкой «Действия»: она проявляется по фокусу.
 */
export const СтрокаСоСвайпом: Story = {
  parameters: { viewport: { defaultViewport: 'w360' } },
  render: () => (
    <Surface>
      {['Ремонт кухни', 'Логотип для кафе'].map((title) => (
        <SwipeActions key={title} actions={ACTIONS} menuLabel="Действия" closeLabel="Закрыть">
          <ListRow avatarName={title} title={title} meta="Анна К. · вы исполнитель" amount="120 000 ₽" onOpen={() => {}} />
        </SwipeActions>
      ))}
    </Surface>
  ),
};
