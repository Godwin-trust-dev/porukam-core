import type { UiDict } from './ui';

/**
 * Ленивая загрузка языковых пакетов интерфейса
 * (docs/tasks/Задача_feat_l10n-launch-surfaces.md §0, ADR-089).
 *
 * `en`/`ru` здесь НЕТ: они в основном бандле (`../index.ts::resources`) —
 * рантайм-дефолт и фолбэк-канон обязаны быть на месте синхронно, до всякой
 * сети. Остальные 27 языков — по одному `import()` на язык: Vite режет их в
 * отдельные чанки, и посетитель скачивает ровно свой язык, а не все 29
 * (статический импорт всех обошёлся бы мегабайтами лишнего JS на стартовом
 * экране — при том что 28 из 29 пакетов конкретному человеку не нужны никогда).
 *
 * Карта статическая (не `import.meta.glob`): `tsc --noEmit` пакета `i18n`
 * гоняется без Vite (та же причина, по которой статичны и `en`/`ru` —
 * ADR-079 §1), а заодно опечатка в коде языка становится ошибкой типа, а не
 * молчаливым отсутствием перевода в рантайме.
 */
export type UiDictLoader = () => Promise<UiDict>;

export const LAZY_LOCALE_LOADERS: Readonly<Record<string, UiDictLoader>> = {
  de: () => import('./de').then((m) => m.de),
  es: () => import('./es').then((m) => m.es),
  fr: () => import('./fr').then((m) => m.fr),
  it: () => import('./it').then((m) => m.it),
  'pt-BR': () => import('./pt-BR').then((m) => m.ptBR),
  pl: () => import('./pl').then((m) => m.pl),
  ro: () => import('./ro').then((m) => m.ro),
  uk: () => import('./uk').then((m) => m.uk),
  tr: () => import('./tr').then((m) => m.tr),
  az: () => import('./az').then((m) => m.az),
  hy: () => import('./hy').then((m) => m.hy),
  ka: () => import('./ka').then((m) => m.ka),
  kk: () => import('./kk').then((m) => m.kk),
  uz: () => import('./uz').then((m) => m.uz),
  id: () => import('./id').then((m) => m.id),
  vi: () => import('./vi').then((m) => m.vi),
  th: () => import('./th').then((m) => m.th),
  hi: () => import('./hi').then((m) => m.hi),
  bn: () => import('./bn').then((m) => m.bn),
  sw: () => import('./sw').then((m) => m.sw),
  ja: () => import('./ja').then((m) => m.ja),
  ko: () => import('./ko').then((m) => m.ko),
  'zh-Hans': () => import('./zh-Hans').then((m) => m.zhHans),
  ar: () => import('./ar').then((m) => m.ar),
  fa: () => import('./fa').then((m) => m.fa),
  he: () => import('./he').then((m) => m.he),
  ur: () => import('./ur').then((m) => m.ur),
};
