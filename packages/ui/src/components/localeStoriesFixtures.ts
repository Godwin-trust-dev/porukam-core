import type { LocaleInfo } from '@porukam/core';

/**
 * Мок-каталог для Storybook (DEV-16a §7 — «sheet со списком, 20+ mock, beta-строки»).
 * Зеркалит форму `web/src/mocks/localesDb.ts` (не импортируем оттуда — `packages/ui`
 * не знает про `web`), без флагов стран, языки без регион-вариантов.
 */
export const STORY_LOCALES: LocaleInfo[] = [
  { code: 'en', self_name: 'English', english_name: 'English', quality: 'human', enabled: true, dir: 'ltr' },
  { code: 'ru', self_name: 'Русский', english_name: 'Russian', quality: 'human', enabled: true, dir: 'ltr' },
  { code: 'es', self_name: 'Español', english_name: 'Spanish', quality: 'machine', enabled: true, dir: 'ltr' },
  { code: 'de', self_name: 'Deutsch', english_name: 'German', quality: 'machine', enabled: true, dir: 'ltr' },
  { code: 'fr', self_name: 'Français', english_name: 'French', quality: 'machine', enabled: true, dir: 'ltr' },
  { code: 'it', self_name: 'Italiano', english_name: 'Italian', quality: 'machine', enabled: true, dir: 'ltr' },
  { code: 'pt', self_name: 'Português', english_name: 'Portuguese', quality: 'machine', enabled: true, dir: 'ltr' },
  { code: 'pl', self_name: 'Polski', english_name: 'Polish', quality: 'machine', enabled: true, dir: 'ltr' },
  { code: 'ro', self_name: 'Română', english_name: 'Romanian', quality: 'machine', enabled: true, dir: 'ltr' },
  { code: 'uk', self_name: 'Українська', english_name: 'Ukrainian', quality: 'machine', enabled: true, dir: 'ltr' },
  { code: 'tr', self_name: 'Türkçe', english_name: 'Turkish', quality: 'machine', enabled: true, dir: 'ltr' },
  { code: 'az', self_name: 'Azərbaycanca', english_name: 'Azerbaijani', quality: 'machine', enabled: true, dir: 'ltr' },
  { code: 'hy', self_name: 'Հայերեն', english_name: 'Armenian', quality: 'machine', enabled: true, dir: 'ltr' },
  { code: 'ka', self_name: 'ქართული', english_name: 'Georgian', quality: 'machine', enabled: true, dir: 'ltr' },
  { code: 'kk', self_name: 'Қазақша', english_name: 'Kazakh', quality: 'machine', enabled: true, dir: 'ltr' },
  { code: 'uz', self_name: 'Oʻzbekcha', english_name: 'Uzbek', quality: 'machine', enabled: true, dir: 'ltr' },
  { code: 'id', self_name: 'Bahasa Indonesia', english_name: 'Indonesian', quality: 'machine', enabled: true, dir: 'ltr' },
  { code: 'vi', self_name: 'Tiếng Việt', english_name: 'Vietnamese', quality: 'machine', enabled: true, dir: 'ltr' },
  { code: 'th', self_name: 'ไทย', english_name: 'Thai', quality: 'machine', enabled: true, dir: 'ltr' },
  { code: 'hi', self_name: 'हिन्दी', english_name: 'Hindi', quality: 'machine', enabled: true, dir: 'ltr' },
  { code: 'sw', self_name: 'Kiswahili', english_name: 'Swahili', quality: 'machine', enabled: true, dir: 'ltr' },
  { code: 'ja', self_name: '日本語', english_name: 'Japanese', quality: 'machine', enabled: true, dir: 'ltr' },
  { code: 'ko', self_name: '한국어', english_name: 'Korean', quality: 'machine', enabled: true, dir: 'ltr' },
  { code: 'zh', self_name: '中文', english_name: 'Chinese', quality: 'machine', enabled: true, dir: 'ltr' },
  { code: 'bn', self_name: 'বাংলা', english_name: 'Bengali', quality: 'machine', enabled: false, dir: 'ltr' },
  { code: 'ar', self_name: 'العربية', english_name: 'Arabic', quality: 'machine', enabled: false, dir: 'rtl' },
  { code: 'fa', self_name: 'فارسی', english_name: 'Persian', quality: 'machine', enabled: false, dir: 'rtl' },
  { code: 'he', self_name: 'עברית', english_name: 'Hebrew', quality: 'machine', enabled: false, dir: 'rtl' },
  { code: 'ur', self_name: 'اردو', english_name: 'Urdu', quality: 'machine', enabled: false, dir: 'rtl' },
];

export const storyLocaleTexts = {
  listTitle: 'Язык интерфейса',
  searchPlaceholder: 'Поиск языка…',
  searchAriaLabel: 'Поиск языка',
  searchClearLabel: 'Очистить поиск',
  retryLabel: 'Повторить',
  currentSectionTitle: 'Текущий',
  allSectionTitle: 'Все языки',
  noResultsText: 'Языки не найдены',
  betaLabel: 'авто-перевод',
  betaTooltip: 'Переведено автоматически — может быть неточно',
  currentAriaLabel: 'Текущий язык',
  closeLabel: 'Закрыть',
  triggerAriaLabel: 'Язык интерфейса',
};
