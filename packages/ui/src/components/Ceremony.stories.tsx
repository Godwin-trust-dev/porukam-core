import type { Meta, StoryObj } from '@storybook/react';
import { Ceremony } from './Ceremony';

const meta: Meta<typeof Ceremony> = {
  title: 'Компоненты/Ceremony',
  component: Ceremony,
};
export default meta;
type Story = StoryObj<typeof Ceremony>;

export const AcceptanceOpen: Story = {
  args: {
    open: true,
    title: 'Этап принят — по рукам!',
    subtitle: 'Этап закрыт, идёт в репутацию',
    doneLabel: 'Готово',
    onDone: () => {},
  },
};

export const SigningOpen: Story = {
  args: {
    open: true,
    title: 'Договор подписан — по рукам!',
    subtitle: 'Версия зафиксирована, обе стороны подписали',
    doneLabel: 'Перейти к исполнению',
    chip: '🔒 v1 · a1b2c3d4… · 31 июля 2026',
    onDone: () => {},
  },
};
