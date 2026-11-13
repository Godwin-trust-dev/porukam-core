import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { dirForLocale } from './dir';

/**
 * RTL-фундамент (DEV-16 §6): держит `<html lang>`/`<html dir>` в синхроне с активным
 * языком интерфейса. Смонтировать один раз у корня (`AppProviders`) — переключение
 * языка (в т.ч. через `LanguageSwitcher`, DEV-16a) обновляет атрибуты без перезагрузки.
 */
export function useHtmlLangDir(): void {
  const { i18n } = useTranslation();
  useEffect(() => {
    const apply = (lng: string): void => {
      document.documentElement.lang = lng;
      document.documentElement.dir = dirForLocale(lng);
    };
    apply(i18n.language);
    i18n.on('languageChanged', apply);
    return () => i18n.off('languageChanged', apply);
  }, [i18n]);
}
