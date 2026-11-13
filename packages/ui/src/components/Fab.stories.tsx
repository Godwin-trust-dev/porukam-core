import type { Meta, StoryObj } from '@storybook/react';
import { Fab } from './Fab';
import { ListRow } from './ListRow';
import { Surface } from './Surface';

const meta: Meta<typeof Fab> = {
  title: 'Компоненты/Fab',
  component: Fab,
};
export default meta;
type Story = StoryObj<typeof Fab>;

/**
 * FAB «Создать» (DEV-20_2 §5) — над нижней навигацией, поверх списка.
 * На ширине ≥1024 он скрыт: там то же действие живёт в шапке экрана.
 */
export const НадСписком: Story = {
  parameters: { viewport: { defaultViewport: 'w360' } },
  render: () => (
    <>
      <Surface>
        {['Ремонт кухни', 'Логотип для кафе', 'Дизайн упаковки', 'Аренда квартиры'].map((title) => (
          <ListRow key={title} avatarName={title} title={title} meta="Контрагент · вы заказчик" amount="45 000 ₽" onOpen={() => {}} />
        ))}
      </Surface>
      <Fab label="Создать" onClick={() => {}} />
    </>
  ),
};

/** ≥1024 — FAB'а нет (проверка «двух входов в одно действие не бывает»). */
export const НаДесктопеСкрыт: Story = {
  ...НадСписком,
  parameters: { viewport: { defaultViewport: 'w1440' } },
};
