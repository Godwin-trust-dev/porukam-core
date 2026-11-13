import type { Meta, StoryObj } from '@storybook/react';
import { FrozenVersion } from './FrozenVersion';

const meta: Meta<typeof FrozenVersion> = {
  title: 'Компоненты/FrozenVersion',
  component: FrozenVersion,
};
export default meta;
type Story = StoryObj<typeof FrozenVersion>;

export const Default: Story = {
  args: {
    title: 'Что вы подписываете',
    version: 'Версия от 31 июля 2026',
    hashLabel: 'Хеш целостности',
    hashShort: 'a1b2c3d4e5f6a1b2…',
    tsaLabel: 'Метка времени',
    tsaTime: '2026-07-31T10:00:00.000Z',
    links: {
      stagesLabel: 'Этапы',
      onStages: () => {},
      checklistsLabel: 'Чек-листы',
      onChecklists: () => {},
      materialsLabel: 'Материалы',
      onMaterials: () => {},
    },
  },
};
