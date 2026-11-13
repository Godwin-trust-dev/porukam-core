import type { Meta, StoryObj } from '@storybook/react';
import { Logo } from './Logo';

const meta: Meta<typeof Logo> = {
  title: 'Основы/Логотип',
  component: Logo,
  parameters: {
    docs: {
      description: {
        component:
          'Единственный знак проекта — рукопожатие со вспышкой (`porukam-logo.png`, DEV-17 §3). ' +
          'Словознак — всегда ОДНИМ цветом: на тёмном — крем, на светлом — ink; правило на всех языках. ' +
          'Где знак: вход/hero, сайдбар (маленький), онбординг, «первые» пустые состояния, церемонии. ' +
          'Где НЕ: на каждой карточке, водяным знаком, рядом с primary-кнопкой, в плотных таблицах. ' +
          'Одна вспышка на экран: рядом со знаком живую искру не запускаем.',
      },
    },
  },
};
export default meta;
type Story = StoryObj<typeof Logo>;

export const Mark: Story = { args: { variant: 'mark', size: 64 } };

export const FullOnLight: Story = {
  args: { variant: 'full', on: 'light', size: 32, wordmark: 'Porukam' },
};

export const FullOnDark: Story = {
  parameters: { backgrounds: { default: 'ink (dark UI)' } },
  args: { variant: 'full', on: 'dark', size: 32, wordmark: 'Porukam' },
};

export const AppIcon: Story = { args: { variant: 'app', size: 64 } };
