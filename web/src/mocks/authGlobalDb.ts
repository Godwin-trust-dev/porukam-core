/**
 * Мок-стор GLOBAL-входа через Google + онбординга (DEV-auth-onboarding, ГВ.2,
 * ADR-071) — зеркалит РЕАЛЬНЫЙ контракт бэка там, где он уже реализован на
 * `main` (`apps.accounts` google-вход, `apps.social` privacy-consents-global),
 * и честно помечено МОК-ТОЛЬКО там, где бэк ещё не построен (Drive-бэкап —
 * ГВ.3, приглашения по ссылке).
 *
 * «Сессия» здесь одна на вкладку — тот же приём, что `profileDb.ts` (`me`
 * singleton): GET /v1/users/me переключается между аккаунтами через
 * `setMe()`, реестр `accounts` хранит состояние каждого «увиденного» sub
 * между входами (повторный вход тем же sub — тот же аккаунт, ADR-071).
 */
import type { ActorProfile, CurrentUser, DriveBackupState, GlobalConsentState, GlobalPrivacyConsentsInput, InviteInfo } from '@porukam/core';
import { getMe, setMe } from './profileDb';

export class MockError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, detail: string) {
    super(detail);
    this.status = status;
    this.code = code;
  }
}

interface GlobalAccount {
  sub: string;
  me: CurrentUser;
  consents: GlobalConsentState;
  driveBackup: DriveBackupState;
}

function emptyConsents(): GlobalConsentState {
  return { pd_processing: null, profile_public: null, phone_discoverability: null, reputation_history_basis: null, completed: false };
}

/** Свежий GLOBAL-аккаунт при первом входе этим `sub` (регистрация, ADR-071) —
 * без телефона/хендла до прохождения онбординга (§4, §6). Person-профиль,
 * однако, ЕСТЬ с самого начала (`profiles`, НЕ `[]`) — на боевом бэке его
 * заводит подписчик `apps.profiles` на `account.logged_in` ПРИ РЕГИСТРАЦИИ,
 * до любого шага онбординга (docs/tasks/
 * Задача_fix_web-profile-settings-real-api.md, ADR-087; backend/apps/profiles/
 * subscriber.py). `handle: ''` на самом профиле — `ActorProfile.handle`
 * типизирован обязательным `string` (отдельный, не тронутый в этой задаче
 * пробел — реальный `ProfileSummarySerializer` его вообще не отдаёт). */
function freshUser(sub: string, email: string, name: string): CurrentUser {
  return {
    id: `u-google-${sub}`,
    handle: null, // как реальный /v1/users/me для свежего аккаунта (Задача_fix_web-profile-handle-real-api.md), не ''
    display_name: name,
    phone: null,
    phone_masked: '',
    verification_level: 'none',
    has_business_status: false,
    profiles: [
      {
        id: `pf-google-${sub}`,
        kind: 'person',
        display_name: name,
        handle: '',
        verification_level: 'none',
        has_business_status: false,
      },
    ],
    reputation_hint: null,
    verificationLevel: 0,
    savedContactsCount: 0,
    orgs: [],
    identity: { masked_email: maskEmail(email), provider: 'google', verified: true },
  };
}

function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  if (!local || !domain) return email;
  const visible = local.slice(0, 2);
  return `${visible}${'•'.repeat(Math.max(1, local.length - visible.length))}@${domain}`;
}

function seedAccounts(): Map<string, GlobalAccount> {
  const m = new Map<string, GlobalAccount>();
  // (c) существующий пользователь — онбординг уже пройден, вход сразу внутрь.
  const existingProfile: ActorProfile = {
    id: 'pf-global-dana',
    kind: 'person',
    display_name: 'Dana',
    handle: '@dana',
    verification_level: 'basic',
    has_business_status: false,
  };
  m.set('sub-existing-1', {
    sub: 'sub-existing-1',
    me: {
      ...freshUser('sub-existing-1', 'dana.existing@example.com', 'Dana'),
      handle: '@dana',
      profiles: [existingProfile],
    },
    consents: { pd_processing: true, profile_public: true, phone_discoverability: false, reputation_history_basis: true, completed: true },
    driveBackup: { connected: true },
  });
  return m;
}

function seedInvites(): Map<string, InviteInfo> {
  const m = new Map<string, InviteInfo>();
  // (b) валидное приглашение — контекст ведёт на РЕАЛЬНО существующий seed-договор
  // из contractsDb (c-3001), чтобы переход после онбординга не бил в 404.
  m.set('invite-tok-1', { fromName: 'Alex', contractId: 'c-3001', contractTitle: 'Сборка шкафа-купе' });
  return m;
}

let accounts = seedAccounts();
let invites = seedInvites();
let activeSub: string | null = null;

/**
 * OAuth-state НЕ в памяти модуля: реальный бэкенд хранит state на сервере и
 * он переживает перезагрузку страницы, а переход на «Google» — именно полная
 * перезагрузка (`window.location.assign`, fix/web-google-redirect-external),
 * которая пересоздаёт MSW-воркер. In-memory Set терялся → 422
 * `google_oauth_state_invalid` на колбэке, весь auth-onboarding e2e стоял
 * (№11-класс, отсмотр 2026-08-18). sessionStorage — зеркало серверного
 * хранилища на время вкладки; в node (vitest) его нет — фолбэк в память.
 */
const GOOGLE_STATES_KEY = 'porukam.mock.google_states';
let googleStatesMem = new Set<string>();

function loadGoogleStates(): Set<string> {
  try {
    const raw = sessionStorage.getItem(GOOGLE_STATES_KEY);
    return new Set(raw ? (JSON.parse(raw) as string[]) : googleStatesMem);
  } catch {
    return googleStatesMem;
  }
}

function saveGoogleStates(states: Set<string>): void {
  googleStatesMem = states;
  try {
    sessionStorage.setItem(GOOGLE_STATES_KEY, JSON.stringify([...states]));
  } catch {
    /* node/vitest — достаточно памяти */
  }
}

export function resetAuthGlobal(): void {
  accounts = seedAccounts();
  invites = seedInvites();
  saveGoogleStates(new Set());
  activeSub = null;
}

function persistActive(): void {
  if (!activeSub) return;
  const account = accounts.get(activeSub);
  if (!account) return;
  accounts.set(activeSub, { ...account, me: getMe() });
}

/** GET /v1/auth/google/authorize-url — в моке ведёт на внутренний роут выбора
 * персоны (`/auth/google/mock`), не на реальный accounts.google.com: реальный
 * OAuth — Ф6 (web/CLAUDE.md §3, VITE_API_MODE=real). */
export function buildAuthorizeUrl(): { authorize_url: string; state: string } {
  const states = loadGoogleStates();
  const state = `mock-state-${states.size}-${Object.keys(Object.fromEntries(accounts)).length}-${Math.random().toString(36).slice(2, 8)}`;
  states.add(state);
  saveGoogleStates(states);
  return { authorize_url: `/auth/google/mock?state=${encodeURIComponent(state)}`, state };
}

/** POST /v1/auth/google/callback — тот же контур, что реальный
 * `complete_google_login` (ADR-071): код кодирует `sub|email` (фейк-провайдер),
 * state — одноразовый. */
export function completeGoogleLogin(code: string, state: string): { user: CurrentUser; created: boolean } {
  const states = loadGoogleStates();
  if (!states.has(state)) {
    throw new MockError(422, 'google_oauth_state_invalid', 'Сессия входа через Google истекла или недействительна');
  }
  states.delete(state);
  saveGoogleStates(states);

  const parts = code.split('|');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new MockError(422, 'google_oauth_code_invalid', 'Код Google не распознан');
  }
  const [sub, email] = parts;

  let account = accounts.get(sub);
  const created = !account;
  if (!account) {
    const name = email.split('@')[0] ?? 'User';
    account = { sub, me: freshUser(sub, email, name.charAt(0).toUpperCase() + name.slice(1)), consents: emptyConsents(), driveBackup: { connected: false } };
    accounts.set(sub, account);
  }

  activeSub = sub;
  setMe(account.me);
  return { user: account.me, created };
}

function requireActive(): GlobalAccount {
  if (!activeSub) throw new MockError(401, 'unauthorized', 'Нужен вход.');
  const account = accounts.get(activeSub);
  if (!account) throw new MockError(401, 'unauthorized', 'Нужен вход.');
  return account;
}

/** GET /v1/users/me/privacy-consents-global (ADR-071, GlobalConsentStateSerializer). */
export function getGlobalConsents(): GlobalConsentState {
  return requireActive().consents;
}

/** POST /v1/users/me/privacy-consents-global — все 4 поля обязательны, без
 * null (§5: «ничего не предзаполнено» относится к ЭКРАНУ до отправки, не к
 * этому вызову — как и на реальном бэке, PrivacyConsentsSerializer). */
export function recordGlobalConsents(input: GlobalPrivacyConsentsInput): GlobalConsentState {
  const account = requireActive();
  const completed = input.pd_processing === true && input.reputation_history_basis === true;
  const consents: GlobalConsentState = { ...input, completed };
  account.consents = consents;
  persistActive();
  return consents;
}

/** GET /v1/users/me/drive-backup — МОК-ТОЛЬКО (реальный Drive-контур — ГВ.3). */
export function getDriveBackup(): DriveBackupState {
  return requireActive().driveBackup;
}

/** POST /v1/users/me/drive-backup — МОК-ТОЛЬКО, отдельный consent-scope от
 * входа (§6: «Позже» не блокирует, отдельный минимальный OAuth-consent). */
export function connectDriveBackup(): DriveBackupState {
  const account = requireActive();
  account.driveBackup = { connected: true };
  persistActive();
  return account.driveBackup;
}

/** POST /v1/users/me/drive/connect/callback — зеркало РЕАЛЬНОГО контура
 * (ADR-084, `EVIDENCE_DRIVE_PROVIDER=real`), в отличие от `connectDriveBackup`
 * выше. На моке нет `authorize-url` для drive-connect (кнопки входа в Settings
 * ещё нет), поэтому state не проверяется по одноразовому реестру — только
 * пустота обеих частей, как честный аналог невалидного возврата от Google. */
export function completeDriveConnect(code: string, state: string): void {
  requireActive();
  if (!state) {
    throw new MockError(422, 'drive_connect_state_invalid', 'Сессия подключения Drive истекла или недействительна');
  }
  if (!code) {
    throw new MockError(422, 'drive_connect_code_invalid', 'Код Google не распознан или не дал доступ офлайн');
  }
  const account = requireActive();
  account.driveBackup = { connected: true };
  persistActive();
}

/** GET /v1/invites/:token — МОК-ТОЛЬКО (у бэка сейчас нет контура приглашений
 * по ссылке); 404 на неизвестный/истёкший токен (§9). */
export function getInvite(token: string): InviteInfo {
  const invite = invites.get(token);
  if (!invite) throw new MockError(404, 'not_found', 'Приглашение не найдено или истекло.');
  return invite;
}

/** Обёртка над `getMe()`/`setMe()` для мутаций handle/name/settings, идущих
 * через уже существующие `PATCH /v1/users/me` и `PATCH /v1/users/me/settings`
 * (`profileHandlers.ts`) — здесь только зеркалим изменение в реестр
 * аккаунтов, чтобы повторный вход тем же `sub` видел сохранённое состояние. */
export function persistActiveAfterProfilePatch(): void {
  persistActive();
}
