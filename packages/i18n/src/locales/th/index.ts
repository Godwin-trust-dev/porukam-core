/**
 * Языковой пакет `th` (машинный перевод). ВСЕ неймспейсы интерфейса
 * (`UI_NAMESPACES`, ../ui.ts) — молчаливого EN-фолбэка внутри продукта нет.
 * Грузится ленивым чанком (../lazy.ts), не статически.
 */
import common from './common.json';
import auth from './auth.json';
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
import type { UiDict } from '../ui';

export const th: UiDict = {
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
};
