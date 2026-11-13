/**
 * Сборка RU-пакета из JSON-файлов по неймспейсам (DEV-16 §1). RU — базовый рантайм-язык
 * (см. `createI18n('ru')` в `web/src/app/providers.tsx`), но НЕ фолбэк-цель — недостающие
 * ключи в любом языке (включая `ru`, если он когда-то отстанет от `en`) падают в EN
 * (`../../index.ts`, `fallbackLng: 'en'`).
 */
import common from './common.json';
import auth from './auth.json';
// onboarding — раньше EN-only (ConsentsPage/ProfileStepPage форсили `en`), форс снят
// (docs/tasks/Задача_fix_web-consents-crash.md §2), у RU теперь есть свой перевод.
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

export const ru = {
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

export type RuDict = typeof ru;
