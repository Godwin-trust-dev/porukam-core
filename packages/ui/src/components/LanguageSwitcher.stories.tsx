import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { LanguageSwitcher } from './LanguageSwitcher';
import { GoogleButton } from './GoogleButton';
import { SettingsNav } from './SettingsNav';
import { STORY_LOCALES, storyLocaleTexts } from './localeStoriesFixtures';

const meta: Meta<typeof LanguageSwitcher> = {
  title: 'Компоненты/LanguageSwitcher',
  component: LanguageSwitcher,
};
export default meta;
type Story = StoryObj<typeof LanguageSwitcher>;

/**
 * DEV-16a §7 — mobile (сузьте окно Storybook <640px) открывает `Sheet` снизу; desktop
 * (>=640px) — anchored dropdown у триггера. Список — 20+ мок-языков, часть — `beta`
 * (machine), часть — отключена (`enabled:false`, приглушённые строки внизу).
 */
function Interactive(variant: 'chip' | 'globe' | 'row'): JSX.Element {
  const [locale, setLocale] = useState('ru');
  return (
    <LanguageSwitcher
      variant={variant}
      locales={STORY_LOCALES}
      currentLocale={locale}
      onPick={setLocale}
      {...storyLocaleTexts}
    />
  );
}

export const Chip: Story = {
  name: 'chip (онбординг)',
  render: () => Interactive('chip'),
};

export const Globe: Story = {
  name: 'globe (шапка гостя)',
  render: () => Interactive('globe'),
};

export const Row: Story = {
  name: 'row (настройки)',
  render: () => Interactive('row'),
};

export const Loading: Story = {
  name: 'загрузка списка (skeleton)',
  args: { variant: 'chip', locales: [], currentLocale: 'ru', loading: true, onPick: () => {}, ...storyLocaleTexts },
};

export const LoadError: Story = {
  name: 'ошибка загрузки — тихо + retry',
  args: {
    variant: 'chip',
    locales: [],
    currentLocale: 'ru',
    errorText: 'Не удалось загрузить список языков',
    onRetry: () => {},
    onPick: () => {},
    ...storyLocaleTexts,
  },
};

/** Онбординг (№12 ло-фая) — chip над кнопкой Google, выбор не блокирует онбординг. */
export const OnboardingContext: Story = {
  name: 'контекст: онбординг (chip над Google)',
  render: () => {
    const [locale, setLocale] = useState('en');
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 360 }}>
        <LanguageSwitcher variant="chip" locales={STORY_LOCALES} currentLocale={locale} onPick={setLocale} {...storyLocaleTexts} />
        <GoogleButton label="Continue with Google" onClick={() => {}} />
      </div>
    );
  },
};

/** Шапка гостя (лендинг/публичная карточка/подписание по ссылке) — globe слева от «Войти». */
export const GuestHeaderContext: Story = {
  name: 'контекст: шапка гостя (globe слева от «Войти»)',
  render: () => {
    const [locale, setLocale] = useState('ru');
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <LanguageSwitcher variant="globe" locales={STORY_LOCALES} currentLocale={locale} onPick={setLocale} {...storyLocaleTexts} />
        <button type="button" style={{ padding: '8px 16px' }}>
          Войти
        </button>
      </div>
    );
  },
};

/** Настройки (№02) — row в группе «Язык и регион». */
export const SettingsContext: Story = {
  name: 'контекст: настройки (row в SettingsNav)',
  render: () => {
    const [locale, setLocale] = useState('ru');
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 420 }}>
        <SettingsNav
          items={[
            { key: 'profile', label: 'Профиль' },
            { key: 'app', label: 'Приложение' },
          ]}
          active="app"
          onSelect={() => {}}
        />
        <LanguageSwitcher variant="row" locales={STORY_LOCALES} currentLocale={locale} onPick={setLocale} {...storyLocaleTexts} />
      </div>
    );
  },
};
