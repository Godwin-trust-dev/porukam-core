import type { Meta, StoryObj } from '@storybook/react';
import { VerificationLevel } from './VerificationLevel';

const meta: Meta<typeof VerificationLevel> = {
  title: 'Компоненты/VerificationLevel',
  component: VerificationLevel,
};
export default meta;
type Story = StoryObj<typeof VerificationLevel>;

export const Level0: Story = { args: { level: 0, label: 'Верификация 0 / 3' } };
export const Level1: Story = { args: { level: 1, label: 'Верификация 1 / 3' } };
export const Level2: Story = { args: { level: 2, label: 'Верификация 2 / 3' } };
export const Level3Full: Story = { args: { level: 3, label: 'Верификация 3 / 3' } };
