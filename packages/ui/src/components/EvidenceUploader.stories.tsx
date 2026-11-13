import type { Meta, StoryObj } from '@storybook/react';
import { EvidenceUploader } from './EvidenceUploader';

const meta: Meta<typeof EvidenceUploader> = {
  title: 'Компоненты/EvidenceUploader',
  component: EvidenceUploader,
};
export default meta;
type Story = StoryObj<typeof EvidenceUploader>;

const base = {
  dropLabel: 'Перетащите файлы сюда',
  browseLabel: 'Выбрать файлы',
  bindLabel: 'Привязать к',
  bindHint: 'Привяжите к пункту — понятнее на приёмке',
  bindOptions: [
    { id: 'stage', label: 'Этап целиком' },
    { id: 'a', label: 'Плитка уложена по всей площади' },
    { id: 'b', label: 'Швы затёрты' },
  ],
  bindValue: 'stage',
  onBindChange: () => {},
  onSelectFiles: () => {},
  cameraStubText: 'Точная съёмка с метками — в приложении (скоро). Сейчас — веб-загрузка.',
};

export const Default: Story = { args: base };
export const Uploading: Story = { args: { ...base, uploading: true, uploadingLabel: 'Загрузка…' } };
