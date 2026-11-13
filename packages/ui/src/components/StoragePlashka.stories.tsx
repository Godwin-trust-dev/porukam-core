import type { Meta, StoryObj } from '@storybook/react';
import { StoragePlashka } from './StoragePlashka';

const meta: Meta<typeof StoragePlashka> = {
  title: 'Компоненты/StoragePlashka',
  component: StoragePlashka,
};
export default meta;
type Story = StoryObj<typeof StoragePlashka>;

export const Info: Story = {
  args: {
    tone: 'info',
    title: 'Оригинал остаётся у вас',
    text: 'Оригинал остаётся у вас (на вашем устройстве). Платформа хранит хеш, метку времени и миниатюру. Подключите резервную копию в Google Drive, чтобы не потерять оригинал.',
    connectLabel: 'Подключить Drive',
    onConnect: () => {},
  },
};

export const Ok: Story = {
  args: {
    tone: 'ok',
    title: 'Копия сохранена в Drive',
    text: 'Копия сохранена в вашем Google Drive. Оригиналы у вас и в Drive. У платформы — хеш и миниатюра.',
    connectedBadge: '✓ копия в Drive',
  },
};
