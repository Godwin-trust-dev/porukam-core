import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { LocaleList } from './LocaleList';
import { STORY_LOCALES, storyLocaleTexts } from './localeStoriesFixtures';

const meta: Meta<typeof LocaleList> = {
  title: 'Компоненты/LocaleList',
  component: LocaleList,
  parameters: { layout: 'padded' },
};
export default meta;
type Story = StoryObj<typeof LocaleList>;

export const Default: Story = {
  name: '20+ языков — секции + поиск (DEV-16a §7)',
  render: () => {
    const [locale, setLocale] = useState('ru');
    return (
      <div style={{ maxWidth: 360 }}>
        <LocaleList locales={STORY_LOCALES} currentCode={locale} onSelect={(l) => setLocale(l.code)} {...storyLocaleTexts} />
      </div>
    );
  },
};

export const Loading: Story = {
  args: { locales: [], currentCode: 'ru', loading: true, onSelect: () => {}, ...storyLocaleTexts },
};

export const LoadError: Story = {
  args: {
    locales: [],
    currentCode: 'ru',
    errorText: 'Не удалось загрузить список языков',
    onRetry: () => {},
    onSelect: () => {},
    ...storyLocaleTexts,
  },
};
