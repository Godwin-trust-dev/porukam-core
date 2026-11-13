import { useTranslation } from 'react-i18next';
import type { LanguageSwitcherProps } from '@porukam/ui';
import { useLocales } from './api';
import { usePickLocale } from './usePickLocale';
import { FALLBACK_LOCALES } from './fallbackLocales';

type TextProps = Omit<LanguageSwitcherProps, 'variant' | 'locales' | 'currentLocale' | 'onPick' | 'loading' | 'errorText' | 'onRetry'>;

/**
 * Общие тексты + данные для `<LanguageSwitcher>` (DEV-16a §5) — единая точка, чтобы
 * не повторять 13 i18n-ключей в каждой точке монтирования (chip/globe/row).
 */
export function useLanguageSwitcherProps(): Pick<
  LanguageSwitcherProps,
  'locales' | 'currentLocale' | 'onPick' | 'loading' | 'errorText' | 'onRetry'
> &
  TextProps {
  const { t, i18n } = useTranslation();
  const { data: locales, isPending, isError, refetch } = useLocales();
  const onPick = usePickLocale();

  return {
    // Пустой/недоступный /v1/locales — не пустой переключатель, а хотя бы
    // бандл-локали (docs/tasks/Задача_fix_web-locales-switcher.md §4.2);
    // ошибка при этом всё равно показывается через errorText/onRetry ниже
    // (LocaleList рендерит error-блок ВМЕСТО списка, см. errorText).
    locales: locales && locales.length > 0 ? locales : FALLBACK_LOCALES,
    currentLocale: i18n.language,
    onPick,
    loading: isPending,
    errorText: isError ? t('locale.loadError') : undefined,
    onRetry: isError ? () => void refetch() : undefined,
    listTitle: t('locale.listTitle'),
    searchPlaceholder: t('locale.searchPlaceholder'),
    searchAriaLabel: t('locale.searchAriaLabel'),
    searchClearLabel: t('locale.searchClear'),
    retryLabel: t('locale.loadErrorRetry'),
    currentSectionTitle: t('locale.currentSectionTitle'),
    allSectionTitle: t('locale.allSectionTitle'),
    noResultsText: t('locale.noResults'),
    betaLabel: t('locale.betaBadge'),
    betaTooltip: t('locale.betaTooltip'),
    currentAriaLabel: t('locale.currentAria'),
    closeLabel: t('locale.closeLabel'),
    triggerAriaLabel: t('locale.globeTriggerAria'),
  };
}
