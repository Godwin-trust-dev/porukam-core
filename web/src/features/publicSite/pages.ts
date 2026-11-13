import { BUNDLED_LOCALE_CODES } from '@porukam/i18n';

/**
 * Публичный контур (ADR-195): страницы, которые читаются БЕЗ входа, и адресная
 * схема языков для них.
 *
 * Модуль намеренно чистый (ни React, ни браузерных API): его импортирует и
 * приложение, и скрипт пререндера (`web/scripts/prerender.mjs`), который гоняет
 * те же страницы в node. Один список маршрутов на оба применения — иначе
 * пререндер молча начнёт отставать от роутера, и в `dist` окажется страница,
 * которой в SPA уже нет (или наоборот).
 */
export const PUBLIC_PAGE_SLUGS = ['about', 'how-it-works', 'trust', 'faq'] as const;

export type PublicPageSlug = (typeof PUBLIC_PAGE_SLUGS)[number];

/**
 * Язык апекса — решение владельца 29.10.2026: «на апексе английский, русский
 * на /ru». Продукт глобальный (29 языков, РФ-контур вынесен в национальный
 * плагин), поэтому `porukam.app/about` — английская версия, а русская живёт на
 * `/ru/about`. Для `en` префикс НЕ выдаётся вообще: две живые копии одной
 * страницы (`/about` и `/en/about`) конкурировали бы в выдаче между собой.
 */
export const APEX_LOCALE = 'en';

/** Префиксы языков, которые реально встречаются в адресах (все, кроме апекса). */
export const PREFIXED_LOCALES: readonly string[] = BUNDLED_LOCALE_CODES.filter(
  (code) => code !== APEX_LOCALE,
);

/** Адрес публичной страницы: `publicPath('ru', 'faq')` → `/ru/faq`, `publicPath('en')` → `/`. */
export function publicPath(locale: string, slug?: PublicPageSlug): string {
  const prefix = locale === APEX_LOCALE ? '' : `/${locale}`;
  if (!slug) return prefix === '' ? '/' : prefix;
  return `${prefix}/${slug}`;
}

/**
 * Разбор адреса в пару «язык + страница». `null` — адрес не относится к
 * публичному контуру (значит это маршрут приложения, и язык решает профиль
 * человека, а не URL).
 *
 * Пустой `slug` означает лендинг (`/` или `/<locale>`).
 */
export function parsePublicPath(pathname: string): { locale: string; slug?: PublicPageSlug } | null {
  const parts = pathname.split('/').filter(Boolean);
  if (parts.length === 0) return { locale: APEX_LOCALE };

  const [first, ...rest] = parts;
  const prefixed = PREFIXED_LOCALES.includes(first!);
  const locale = prefixed ? first! : APEX_LOCALE;
  const tail = prefixed ? rest : parts;

  if (tail.length === 0) return prefixed ? { locale } : null;
  if (tail.length > 1) return null;
  const slug = tail[0] as PublicPageSlug;
  return PUBLIC_PAGE_SLUGS.includes(slug) ? { locale, slug } : null;
}

/** Все адреса публичного контура — 29 языков × (лендинг + 4 страницы). Для пререндера и sitemap. */
export function allPublicPaths(): Array<{ locale: string; slug?: PublicPageSlug; path: string }> {
  const out: Array<{ locale: string; slug?: PublicPageSlug; path: string }> = [];
  for (const locale of [APEX_LOCALE, ...PREFIXED_LOCALES]) {
    out.push({ locale, path: publicPath(locale) });
    for (const slug of PUBLIC_PAGE_SLUGS) out.push({ locale, slug, path: publicPath(locale, slug) });
  }
  return out;
}
