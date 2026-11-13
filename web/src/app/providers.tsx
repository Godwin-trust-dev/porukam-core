import { type ReactNode, useEffect } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nextProvider } from 'react-i18next';
import { createI18n, useHtmlLangDir } from '@porukam/i18n';
import { Toast } from '@porukam/ui';
import { useLocaleResolution } from '../features/locale/useLocaleResolution';
import { initialLocale } from '../features/locale/initialLocale';
import { setDefaultFormatLocale, setDefaultFormatTimeZone } from '@porukam/core';
import { setActiveLocale } from '../shared/activeLocale';

// Экспортирован для e2e-хука псевдолокали (window.__mockDebug.setPseudoLocale,
// web/src/mocks/browser.ts, DEV-16 §1 ⭐ — тест на длинные строки) и для
// предзагрузки языкового пакета в `main.tsx` (см. `initialLocale`).
//
// Язык ПЕРВОГО КАДРА — не жёсткий `'ru'`, а выбор гостя/язык браузера
// (`initialLocale`, feat/l10n-launch-surfaces §0): рантайм-дефолт «ru» был
// наследием RU-первого MVP и заставлял всех остальных сначала увидеть русский
// экран, а свой — только после резолюции. Фолбэк недостающих ключей —
// по-прежнему EN и НЕЗАВИСИМО от этого (`fallbackLng`, ADR-079 §1).
export const i18n = createI18n(initialLocale());

// DEV-16b — ApiClient.getLocale() читает это на каждый запрос (Accept-Language), не
// импортируя `i18n` напрямую (см. shared/activeLocale.ts — избегаем цикла импортов).
setActiveLocale(i18n.language);
i18n.on('languageChanged', setActiveLocale);

// ADR-142 — компоненты `packages/ui` зовут форматтеры дат/денег из core без `locale`;
// без этой синхронизации любые их даты («подписано 27 авг.») и разряды сумм всегда
// выводились в ru-RU независимо от языка интерфейса (замечание тестеров 27.08).
setDefaultFormatLocale(i18n.language);
i18n.on('languageChanged', setDefaultFormatLocale);

// Пояс отображения — устройства пользователя, а не Europe/Moscow: иначе исполнитель
// в Джакарте видел срок приёмки по московскому времени. Юрзначимые даты печатаются
// с меткой пояса (см. `formatDateTime`), поэтому у сторон в разных поясах момент
// времени остаётся однозначным.
const deviceTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
if (deviceTimeZone) setDefaultFormatTimeZone(deviceTimeZone);

// Модульный синглтон (не per-instance useState): mocks/browser.ts инвалидирует
// кэш из e2e-хуков (window.__mockDebug), для чего нужна ссылка на клиента снаружи React.
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, refetchOnWindowFocus: false, staleTime: 30_000 },
  },
});

// DEV-16 §6 — держит `<html lang>`/`<html dir>` в синхроне с активным языком;
// отдельный компонент, чтобы обращаться к `useTranslation()` внутри `<I18nextProvider>`.
function HtmlLangDirSync(): null {
  useHtmlLangDir();
  return null;
}

// DEV-16a §3/§4 — разовое разрешение активного языка (гость/профиль/автоопределение +
// фолбэк отключённой локали) и тихий тост «{Язык} временно недоступен», если сработал
// фолбэк. Монтируется один раз у корня — независимо от того, виден ли где-то на экране
// сам `LanguageSwitcher`.
function LocaleResolutionSync(): JSX.Element | null {
  const { toastText, dismissToast } = useLocaleResolution();
  useEffect(() => {
    if (!toastText) return;
    const id = setTimeout(dismissToast, 4000);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [toastText]);
  return toastText ? <Toast text={toastText} /> : null;
}

export function AppProviders({ children }: { children: ReactNode }): JSX.Element {
  return (
    <QueryClientProvider client={queryClient}>
      <I18nextProvider i18n={i18n}>
        <HtmlLangDirSync />
        <LocaleResolutionSync />
        {children}
      </I18nextProvider>
    </QueryClientProvider>
  );
}
