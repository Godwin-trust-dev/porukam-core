import type { Meta, StoryObj } from '@storybook/react';
import { CameraStub } from './CameraStub';

const meta: Meta<typeof CameraStub> = {
  title: 'Компоненты/CameraStub',
  component: CameraStub,
};
export default meta;
type Story = StoryObj<typeof CameraStub>;

export const Default: Story = {
  args: { text: 'Точная съёмка с метками — в приложении (скоро). Сейчас — веб-загрузка.' },
};
