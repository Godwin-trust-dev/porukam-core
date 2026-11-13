import type { EnDict } from './en';

/**
 * ВСЕ неймспейсы интерфейса (docs/tasks/Задача_feat_l10n-launch-surfaces.md §0:
 * каждое слово — на языке пользователя). Первая волна (ADR-089) переводила
 * только стартовые поверхности — `common`/`auth`/`onboarding`/`locale`/`legal`, —
 * и обещала, что следующая волна просто расширит ЭТОТ список. Она его и
 * расширила: остальные 19 неймспейсов (`contract`, `contractNew`, `dashboard`,
 * `signing`, `stage`, `archive`, …) переведены на все 29 языков, и молчаливого
 * EN-фолбэка внутри продукта больше нет нигде.
 *
 * Порядок — как в EN-каноне (`./en/index.ts`), чтобы диффы читались.
 */
export const UI_NAMESPACES = [
  'common',
  'auth',
  'onboarding',
  'nav',
  'shell',
  'actor',
  'profile',
  'segment',
  'emptySection',
  'contract',
  'reputation',
  'dashboard',
  'acceptance',
  'archive',
  'stage',
  'contracts',
  'contractNew',
  'signing',
  'payment',
  'review',
  'notifications',
  'pwa',
  'locale',
  'legal',
  'hints',
  'help',
  // Контур разногласий и гарантии (этап 7 бэкенда, ADR-131): карточка спора,
  // окна возражений, гарантийная претензия.
  'dispute',
  // Публичные страницы сайта («О проекте»): тексты сгенерированы из витрины Play
  // скриптом scripts/l10n/import-store-listing.mjs, источник истины — docs/ops/store-listing/*.txt.
  'site',
] as const;

/**
 * Языковой пакет интерфейса. `Pick<EnDict, …>` — не `Partial`: набор КЛЮЧЕЙ
 * внутри каждого неймспейса (включая вложенные объекты вроде `contract.card`
 * и `contractNew.typeForm.rent`) обязан совпадать с EN-каноном, иначе
 * `tsc --noEmit` пакета падает на конкретном языке. Это единственная защита,
 * которая ловит обрезанный машинный перевод на 27 языках раньше прода
 * (значения при этом — обычные `string`: JSON-импорт не сужает их до литералов,
 * то есть перевод текста типу не противоречит, а пропущенный ключ противоречит).
 */
export type UiDict = Pick<EnDict, (typeof UI_NAMESPACES)[number]>;
