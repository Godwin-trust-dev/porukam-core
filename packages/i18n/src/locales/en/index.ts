/**
 * Сборка EN-пакета из JSON-файлов по неймспейсам (DEV-16 §1). EN — исходный/канонический
 * язык (fallback-цель для всех остальных, см. `../../index.ts`). Порядок импортов —
 * порядок неймспейсов в исходном `ru.ts` до миграции, сохранён для читаемости диффов.
 */
import common from './common.json';
import auth from './auth.json';
// Раньше EN-only (GLOBAL-вход/онбординг, DEV-auth-onboarding): `ConsentsPage`/
// `ProfileStepPage` принудительно держали `en` (`useForceLocale('en')`)
// независимо от языка интерфейса. Форс снят (docs/tasks/
// Задача_fix_web-consents-crash.md §2) — у `ru`-пакета теперь ЕСТЬ этот
// неймспейс (`../ru/onboarding.json`), см. `../ru/index.ts`. `BackupStepPage`/
// `AuthCallbackPage`/мок `GoogleMockPage` форс ещё держат — их RU-текст вне
// скоупа этой задачи, для них `fallbackLng: 'en'` по-прежнему закрывает разрыв.
import onboarding from './onboarding.json';
import nav from './nav.json';
import shell from './shell.json';
import actor from './actor.json';
import profile from './profile.json';
import segment from './segment.json';
import emptySection from './emptySection.json';
import contract from './contract.json';
import reputation from './reputation.json';
import dashboard from './dashboard.json';
import acceptance from './acceptance.json';
import archive from './archive.json';
import stage from './stage.json';
import contracts from './contracts.json';
import contractNew from './contractNew.json';
import signing from './signing.json';
import payment from './payment.json';
import review from './review.json';
import notifications from './notifications.json';
import pwa from './pwa.json';
import locale from './locale.json';
import legal from './legal.json';
import hints from './hints.json';
import help from './help.json';
import dispute from './dispute.json';
import site from './site.json';

export const en = {
  common,
  auth,
  onboarding,
  nav,
  shell,
  actor,
  profile,
  segment,
  emptySection,
  contract,
  reputation,
  dashboard,
  acceptance,
  archive,
  stage,
  contracts,
  contractNew,
  signing,
  payment,
  review,
  notifications,
  pwa,
  locale,
  legal,
  hints,
  help,
  dispute,
  site,
} as const;

export type EnDict = typeof en;
