import type { Meta, StoryObj } from '@storybook/react';
import { SignResult } from './SignResult';

const meta: Meta<typeof SignResult> = {
  title: 'Компоненты/SignResult',
  component: SignResult,
  parameters: { backgrounds: { default: 'dark' } },
};
export default meta;
type Story = StoryObj<typeof SignResult>;

export const SingleLanguage: Story = {
  name: 'одноязычная — только hash',
  args: { chip: '🔒 ver-1001 · a1b2c3d4e5f6a1b2… · 31 июля 2026' },
};

export const CrossLanguage: Story = {
  name: 'разноязычная — + строка офиц. текста',
  args: {
    chip: '🔒 ver-1001 · a1b2c3d4e5f6a1b2… · 31 июля 2026',
    languageNote: 'Официальный текст — English',
  },
};
