/**
 * Реестр языков, у которых В БАНДЛЕ есть перевод стартовых поверхностей
 * (docs/tasks/Задача_feat_l10n-launch-surfaces.md §A/§C) — 29 языков:
 * `en` (канон) + `ru` (ревью носителем) статически, остальные 27 — ленивыми
 * чанками (`lazy.ts`).
 *
 * Зачем реестр в `packages/i18n`, если список языков отдаёт `GET /v1/locales`:
 * это два РАЗНЫХ факта. Эндпоинт говорит, какие языки ВКЛЮЧЕНЫ продуктово
 * (`Locale.enabled`, рубильник ops); реестр — какие языки физически есть в
 * этой сборке фронта. Правило §0 («стартовые экраны полностью на языке
 * пользователя») выполняется только на их пересечении, поэтому оба списка
 * нужны явно, а не один вместо другого:
 *   - язык включён на бэке, но не собран во фронте → молчаливый EN-фолбэк,
 *     ровно то, что §0 запрещает (так и было до этой ветки: 27 языков в
 *     переключателе, переводы только en/ru — ADR-079 «Последствия»);
 *   - язык собран, но выключен на бэке → недоступен для выбора, и это
 *     нормально (например пока не готов юр-документ, §C).
 *
 * `code`/`selfName`/`rtl`/`quality` — те же значения, что в шапках
 * `l10n/packs/<code>.json` (единый источник для бэкенда: `import_l10n_pack`
 * заводит из них `Locale`); `englishName` — тот же справочник, что
 * `backend/apps/l10n/api/serializers.py::ENGLISH_NAMES`. Расхождение кодов
 * между этими списками означало бы «язык есть, но выбрать нельзя» —
 * стерегущий тест: `packages/i18n/src/locales/registry.test.ts`.
 *
 * Коды — как в пакетах, включая регион-тэгированные (`pt-BR`, `zh-Hans`), а
 * НЕ огрублённые до примарной подгруппы (`pt`, `zh`): огрубление разошлось бы
 * с бэкендом, у которого `Locale.code` — код пакета.
 */

export interface LocaleMeta {
  /** BCP-47, как в `l10n/packs/<code>.json` и в `Locale.code`. */
  code: string;
  /** Само-название — то, что носитель видит в переключателе. */
  selfName: string;
  /** Английское название — для поиска по списку не-носителем. */
  englishName: string;
  rtl: boolean;
  /** `human` — канон/ревью носителем; `machine` — тихая пометка «beta». */
  quality: 'human' | 'machine';
}

/** Языки, чей пакет статически в основном бандле (рантайм-дефолт + фолбэк-канон). */
export const EAGER_LOCALES = ['en', 'ru'] as const;

export const LOCALE_REGISTRY: readonly LocaleMeta[] = [
  { code: 'ar', selfName: 'العربية', englishName: 'Arabic', rtl: true, quality: 'machine' },
  { code: 'az', selfName: 'Azərbaycanca', englishName: 'Azerbaijani', rtl: false, quality: 'machine' },
  { code: 'bn', selfName: 'বাংলা', englishName: 'Bengali', rtl: false, quality: 'machine' },
  { code: 'de', selfName: 'Deutsch', englishName: 'German', rtl: false, quality: 'machine' },
  { code: 'en', selfName: 'English', englishName: 'English', rtl: false, quality: 'human' },
  { code: 'es', selfName: 'Español', englishName: 'Spanish', rtl: false, quality: 'machine' },
  { code: 'fa', selfName: 'فارسی', englishName: 'Persian', rtl: true, quality: 'machine' },
  { code: 'fr', selfName: 'Français', englishName: 'French', rtl: false, quality: 'machine' },
  { code: 'he', selfName: 'עברית', englishName: 'Hebrew', rtl: true, quality: 'machine' },
  { code: 'hi', selfName: 'हिन्दी', englishName: 'Hindi', rtl: false, quality: 'machine' },
  { code: 'hy', selfName: 'Հայերեն', englishName: 'Armenian', rtl: false, quality: 'machine' },
  { code: 'id', selfName: 'Bahasa Indonesia', englishName: 'Indonesian', rtl: false, quality: 'machine' },
  { code: 'it', selfName: 'Italiano', englishName: 'Italian', rtl: false, quality: 'machine' },
  { code: 'ja', selfName: '日本語', englishName: 'Japanese', rtl: false, quality: 'machine' },
  { code: 'ka', selfName: 'ქართული', englishName: 'Georgian', rtl: false, quality: 'machine' },
  { code: 'kk', selfName: 'Қазақша', englishName: 'Kazakh', rtl: false, quality: 'machine' },
  { code: 'ko', selfName: '한국어', englishName: 'Korean', rtl: false, quality: 'machine' },
  { code: 'pl', selfName: 'Polski', englishName: 'Polish', rtl: false, quality: 'machine' },
  { code: 'pt-BR', selfName: 'Português (Brasil)', englishName: 'Portuguese (Brazil)', rtl: false, quality: 'machine' },
  { code: 'ro', selfName: 'Română', englishName: 'Romanian', rtl: false, quality: 'machine' },
  { code: 'ru', selfName: 'Русский', englishName: 'Russian', rtl: false, quality: 'human' },
  { code: 'sw', selfName: 'Kiswahili', englishName: 'Swahili', rtl: false, quality: 'machine' },
  { code: 'th', selfName: 'ไทย', englishName: 'Thai', rtl: false, quality: 'machine' },
  { code: 'tr', selfName: 'Türkçe', englishName: 'Turkish', rtl: false, quality: 'machine' },
  { code: 'uk', selfName: 'Українська', englishName: 'Ukrainian', rtl: false, quality: 'machine' },
  { code: 'ur', selfName: 'اردو', englishName: 'Urdu', rtl: true, quality: 'machine' },
  { code: 'uz', selfName: 'Oʻzbekcha', englishName: 'Uzbek', rtl: false, quality: 'machine' },
  { code: 'vi', selfName: 'Tiếng Việt', englishName: 'Vietnamese', rtl: false, quality: 'machine' },
  { code: 'zh-Hans', selfName: '简体中文', englishName: 'Chinese (Simplified)', rtl: false, quality: 'machine' },
];

export const BUNDLED_LOCALE_CODES: readonly string[] = LOCALE_REGISTRY.map((l) => l.code);

export function localeMeta(code: string): LocaleMeta | undefined {
  return LOCALE_REGISTRY.find((l) => l.code === code);
}

/**
 * Код языка из реестра для произвольного языкового тега — с точным матчем,
 * затем по примарной подгруппе в обе стороны (`pt-BR` → `pt-BR`; `pt` →
 * `pt-BR`; `zh-CN` → `zh-Hans`). `undefined` — языка в сборке нет.
 *
 * Нужен потому, что `navigator.language`/`Accept-Language` и `Locale.code`
 * живут в разных «разрешениях»: браузер говорит `pt-PT`/`zh-TW`/`es-419`, а
 * пакет называется `pt-BR`/`zh-Hans`/`es`. Наивное срезание региона
 * (`code.split('-')[0]`) закрывает только половину случаев и отправляет
 * бразильского гостя в английский — это и был баг до этой ветки
 * (`detectGuestLocale`).
 */
export function matchBundledLocale(tag: string | undefined | null): string | undefined {
  if (!tag) return undefined;
  const wanted = tag.trim();
  if (!wanted) return undefined;

  const exact = LOCALE_REGISTRY.find((l) => l.code.toLowerCase() === wanted.toLowerCase());
  if (exact) return exact.code;

  const primary = wanted.split('-')[0]?.toLowerCase();
  if (!primary) return undefined;
  const byPrimary = LOCALE_REGISTRY.find((l) => l.code.split('-')[0]?.toLowerCase() === primary);
  return byPrimary?.code;
}
