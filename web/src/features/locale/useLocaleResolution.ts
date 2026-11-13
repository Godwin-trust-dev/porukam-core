import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuthStore } from '../auth/authStore';
import { useCurrentUser } from '../auth/useAuth';
import { useUpdateLocale } from '../profile/api';
import { useLocales } from './api';
import { useGuestLocaleStore } from './localeStore';
import { detectGuestLocale } from './detectLocale';
import { FALLBACK_LOCALES } from './fallbackLocales';
import { applyLocale } from './applyLocale';
import { matchBundledLocale } from '@porukam/i18n';
import { parsePublicPath } from '../publicSite/pages';

/**
 * Явный `?lang=` на публичных юр-страницах (`/legal/*`): ссылка для магазинов и
 * проверяющих («дай английский», не зависимо от профиля и браузера). Без этого
 * разрешение языка, отработав ПОСЛЕ страницы (когда пришёл `/v1/locales`/профиль),
 * возвращало бы язык профиля/браузера поверх запрошенного. В профиль не пишется.
 */
export function explicitLegalLang(pathname: string, search: string): string | null {
  if (!pathname.startsWith('/legal/')) return null;
  return matchBundledLocale(new URLSearchParams(search).get('lang')) ?? null;
}

/**
 * Разовое разрешение активного языка интерфейса (DEV-16a §3/§4) — монтируется ОДИН РАЗ
 * у корня приложения (`AppProviders`), не в каждой точке монтирования `LanguageSwitcher`:
 * фолбэк на отключённую локаль должен сработать даже на экране без самого переключателя.
 *
 * Приоритет источника: залогинен → `me.locale`, а если в профиле языка ещё нет —
 * выбор, сделанный этим же человеком, пока он был гостем; гость → выбор из сессии
 * (`useGuestLocaleStore`); нет ничего → автоопределение по `navigator.language`.
 * Гостевой выбор при этом ДОезжает в профиль (`useUpdateLocale`, ADR-095): иначе
 * человек выбирает язык на /welcome, регистрируется — и первый экран после входа
 * встречает его языком браузера, потому что `me.locale` пуст.
 * Если выбранный код известен, но `enabled: false` — откатываемся на `en` и просим
 * показать тост (см. `LocaleResolutionSync` в `providers.tsx`).
 *
 * `GET /v1/locales` недоступен (ошибка) или вернул пустой список — резолвим по
 * `FALLBACK_LOCALES` (en/ru), а не молчим/не откатываемся принудительно на `en`
 * независимо от языка браузера (docs/tasks/Задача_fix_web-locales-switcher.md §4.2).
 */
export function useLocaleResolution(): { toastText: string | null; dismissToast: () => void } {
  const { i18n, t } = useTranslation();
  const { data: locales, isError } = useLocales();
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const { data: me } = useCurrentUser();
  const guestLocale = useGuestLocaleStore((s) => s.locale);
  const updateLocale = useUpdateLocale();
  const adoptedGuestLocale = useRef(false);
  const [toastText, setToastText] = useState<string | null>(null);

  useEffect(() => {
    if (!locales && !isError) return; // ещё грузится — ждём, не резолвим по неполным данным
    if (isAuthenticated && !me) return; // ждём профиль — иначе на миг решим как для гостя
    const effectiveLocales = locales && locales.length > 0 ? locales : FALLBACK_LOCALES;
    const enabledCodes = effectiveLocales.filter((l) => l.enabled).map((l) => l.code);
    // Публичная страница (ADR-195) задаёт язык АДРЕСОМ: `/ru/faq` — русская
    // версия, и ни выбор в сессии, ни язык браузера её не перебивают. Для
    // залогиненного это не действует: внутри приложения язык — свойство
    // профиля, а публичные страницы он открывает как гость.
    const pathLocale = isAuthenticated ? undefined : parsePublicPath(window.location.pathname)?.locale;
    const explicitLang = explicitLegalLang(window.location.pathname, window.location.search);
    const intended = explicitLang ?? (isAuthenticated ? (me?.locale ?? guestLocale) : (pathLocale ?? guestLocale));

    // Гостевой выбор, переживший вход, закрепляем в профиле — один раз за
    // монтирование: без этого он остался бы в sessionStorage и умер вместе с
    // вкладкой, а на другом устройстве человек снова получил бы автоопределение.
    if (!explicitLang && isAuthenticated && !me?.locale && guestLocale && !adoptedGuestLocale.current) {
      adoptedGuestLocale.current = true;
      void updateLocale.mutateAsync(guestLocale).catch(() => undefined);
    }

    let resolved: string;
    if (intended && enabledCodes.includes(intended)) {
      resolved = intended;
    } else if (intended) {
      const info = effectiveLocales.find((l) => l.code === intended);
      resolved = 'en';
      if (info) setToastText(t('locale.disabledToast', { lang: info.self_name }));
    } else {
      resolved = detectGuestLocale(navigator.language, enabledCodes);
    }

    if (i18n.language !== resolved) void applyLocale(i18n, resolved);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locales, isError, isAuthenticated, me, guestLocale]);

  return { toastText, dismissToast: () => setToastText(null) };
}
