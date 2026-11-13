/**
 * Снимки интерфейса для лендинга — полоса кадров, как в карточке магазина.
 *
 * Модуль чистый (ни React, ни браузерных API): его читают и лендинг, и
 * проверка `web/tests/siteShots.test.ts`, которая сверяет список с файлами на
 * диске и ключи подписей — с языковыми пакетами.
 *
 * ОТКУДА КАДРЫ. Это те же снимки, что уехали в витрину Google Play и RuStore
 * (`docs/ops/store-listing/screenshots/{en,ru}`), пережатые в WebP скриптом
 * `scripts/ops/build-site-shots.mjs`. Снимать для сайта отдельный набор значило
 * бы завести вторую витрину, которая разойдётся с магазинной на первой же
 * правке интерфейса.
 *
 * ЯЗЫК В КАДРЕ. Кадры существуют на двух языках: английские (Google Play) и
 * русские (RuStore). Страница на русском показывает русские, все остальные 28 —
 * английские. Это то же решение, что принято по ролику 29.10 («только
 * английский, остальное субтитры»), только здесь русский набор УЖЕ снят и
 * отдать его русской версии ничего не стоит.
 *
 * ПОДПИСИ — ТОЛЬКО СУЩЕСТВУЮЩИЕ КЛЮЧИ. Под каждым кадром стоит название того
 * самого экрана, взятое из интерфейса, а не написанный заново рекламный текст:
 * иначе на лендинге появился бы третий набор формулировок (после магазина и
 * блоков страницы), которого никто не утверждал и который пришлось бы
 * переводить на 29 языков. Рассказ «что это даёт» уже идёт ниже, в блоках.
 */

/** Языки, на которых сняты кадры интерфейса. */
export const SITE_SHOT_LANGS = ['en', 'ru'] as const;

export type SiteShotLang = (typeof SITE_SHOT_LANGS)[number];

export type SiteShot = {
  /** Имя файла внутри `public/media/shots/<lang>/`. */
  readonly file: string;
  /** Ключ i18n с названием экрана — он же подпись и `alt` кадра. */
  readonly captionKey: string;
};

/**
 * Порядок — путь сделки: главная → список сделок → карточка → приёмка →
 * подпись → чат → репутация → создание нового договора. Тот же рассказ, что
 * в блоках лендинга и в ролике, только экранами.
 */
export const SITE_SHOTS: readonly SiteShot[] = [
  { file: '01-home.webp', captionKey: 'nav.home' },
  { file: '02-deals.webp', captionKey: 'contracts.title' },
  { file: '03-contract.webp', captionKey: 'contract.tabs.overview' },
  { file: '04-stages.webp', captionKey: 'acceptance.title' },
  { file: '05-sign.webp', captionKey: 'contract.signTitle' },
  { file: '06-chat.webp', captionKey: 'nav.chat' },
  { file: '07-reputation.webp', captionKey: 'nav.reputation' },
  { file: '08-new-contract.webp', captionKey: 'contract.createTitle' },
];

/**
 * Размер файлов. Пропорции у наборов РАЗНЫЕ и это не недосмотр: кадр Google
 * Play обязан укладываться в сторону не длиннее двойной короткой (2:1), а
 * RuStore ждёт портрет телефона 9:16. Размер проставляется атрибутами `width`
 * и `height`, чтобы страница не прыгала, пока кадры грузятся.
 */
export const SITE_SHOT_SIZE: Record<SiteShotLang, { width: number; height: number }> = {
  en: { width: 540, height: 1080 },
  ru: { width: 540, height: 960 },
};

/** Набор кадров для языка страницы: русский — свой, остальные — английский. */
export function siteShotLang(locale: string): SiteShotLang {
  return locale === 'ru' ? 'ru' : 'en';
}

/** Адрес кадра. `/media/` раздаёт nginx мимо прекеша PWA (см. `vite.config.ts`). */
export function siteShotSrc(lang: SiteShotLang, file: string): string {
  return `/media/shots/${lang}/${file}`;
}
