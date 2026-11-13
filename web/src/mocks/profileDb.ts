/**
 * Мок-стор личного кабинета владельца (DEV-02 §6): профиль/настройки — мутируемая
 * копия seed из data.ts, PATCH — оптимистичные мутации поверх in-memory состояния.
 * Уведомления и сессии — отдельные списки с собственными мутациями (logout/logout-all).
 */
import type { CurrentUser, DeviceSession, OwnerVerificationLevel } from '@porukam/core';
import { handleDirectory } from './catalog';
import { mockSessions, mockUser } from './data';
import { applyDemoEn } from './demoEn';

export class MockError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, detail: string) {
    super(detail);
    this.status = status;
    this.code = code;
  }
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

let me: CurrentUser = clone(mockUser);
let sessions = clone(mockSessions);

/** Согласия ПОСЛЕ регистрации (`GET`/`POST /users/me/consents`, apps.social) —
 * docs/tasks/Задача_fix_web-profile-settings-real-api.md. ОТДЕЛЬНО от
 * GLOBAL-стартового пакета (`authGlobalDb.ts` — `/users/me/privacy-consents-global`,
 * свой стор на аккаунт); здесь — общий синглтон уровня "текущая сессия" (тот же
 * приём, что `me` в этом файле — не идеально по multi-аккаунтной точности для
 * GLOBAL, но ничего в тестах не переключает аккаунт И проверяет independent
 * per-account consents одновременно). RU-мок начинает полностью согласившимся
 * (существующий пользователь, `data.ts:mockUser` — уже прошёл регистрацию). */
export interface MyConsentsState {
  pd_processing: boolean | null;
  profile_public: boolean | null;
  phone_discoverability: boolean | null;
  completed: boolean;
}
let myConsents: MyConsentsState = { pd_processing: true, profile_public: true, phone_discoverability: true, completed: true };

/**
 * Справочник контактов (`GET /v1/users/me/contacts`, apps.social, ADR-106).
 * Сид — контрагенты из `handleDirectory`, чтобы книга контактов на шаге
 * «Стороны» и поиск по хендлу говорили об одних и тех же людях: только тогда
 * видно пометку «в контактах» и работает переход «искать на платформе».
 * `@masha` хендла в справочнике не имеет — контакт из телефонной книги,
 * выбрать его контрагентом нельзя (нужен `counterparty_handle`).
 */
export interface MockContact {
  id: string;
  target_user: string | null;
  target_handle: string | null;
  target_display_name: string;
  target_profile_id: string | null;
  /** ADR-173: фото контакта; в моке картинок нет — null. */
  target_avatar_url: string | null;
  display_name: string | null;
  source: string;
  is_mutual: boolean;
  created_at: string;
}

function seedContacts(): MockContact[] {
  const fromDirectory = (handle: string, source: string, createdAt: string): MockContact => {
    const entry = handleDirectory.find((h) => h.handle === handle);
    return {
      id: `contact-${handle.replace('@', '')}`,
      target_user: `user-${handle.replace('@', '')}`,
      target_handle: handle,
      target_display_name: entry?.display_name ?? '',
      target_profile_id: null,
      target_avatar_url: null,
      display_name: null,
      source,
      is_mutual: source === 'deal',
      created_at: createdAt,
    };
  };
  return [
    fromDirectory('@masterremont', 'deal', '2026-08-20T10:00:00Z'),
    fromDirectory('@irina_s', 'manual', '2026-08-12T09:00:00Z'),
    {
      id: 'contact-masha',
      target_user: 'user-masha',
      target_handle: null,
      target_display_name: 'Мария Соколова',
      target_profile_id: null,
      target_avatar_url: null,
      display_name: null,
      source: 'phonebook',
      is_mutual: false,
      created_at: '2026-08-05T08:00:00Z',
    },
  ];
}

/** Английский демо-набор витрины (`demoEn.ts`) — без флага no-op. */
let contacts: MockContact[] = applyDemoEn(seedContacts());

export function listContacts(): MockContact[] {
  return contacts;
}

export function addContact(contact: MockContact): void {
  contacts.unshift(contact);
}

export function removeContact(id: string): boolean {
  const idx = contacts.findIndex((c) => c.id === id);
  if (idx < 0) return false;
  contacts.splice(idx, 1);
  return true;
}

export function resetProfile(): void {
  me = clone(mockUser);
  sessions = clone(mockSessions);
  contacts = applyDemoEn(seedContacts());
  myConsents = { pd_processing: true, profile_public: true, phone_discoverability: true, completed: true };
}

export function getMyConsents(): MyConsentsState {
  return myConsents;
}

export function recordMyConsent(consentType: 'phone_discoverability', value: boolean): MyConsentsState {
  myConsents = { ...myConsents, [consentType]: value };
  return myConsents;
}

export function getMe(): CurrentUser {
  return me;
}

/**
 * Переключение «текущей сессии» на другой мок-аккаунт — используется входом
 * через Google (`authGlobalDb.ts`, DEV-auth-onboarding): один и тот же
 * `GET /v1/users/me` мок обслуживает и OTP-, и Google-сессии (реальный бэк
 * тоже не различает их на этом эндпоинте — тот же `_issue_token_pair`,
 * ADR-071). RU OTP-флоу этой функцией не пользуется, `me` продолжает
 * управляться `patchProfile`/`patchSettings`/`resetProfile`.
 */
export function setMe(next: CurrentUser): void {
  me = next;
}

export type ProfilePatch = Partial<Pick<CurrentUser, 'display_name' | 'locale'>>;

/** PATCH /users/me — только display_name/locale (реальный контракт,
 * docs/tasks/Задача_fix_web-profile-settings-real-api.md); handle сюда
 * больше не приходит вообще (см. claimHandle ниже, ProfilePatch на фронте
 * их не допускает типом). */
export function patchProfile(patch: ProfilePatch): CurrentUser {
  me = { ...me, ...patch };
  return me;
}

export function isHandleAvailable(handle: string): boolean {
  const normalized = handle.toLowerCase();
  if (me.handle && normalized === me.handle.toLowerCase()) return true;
  const taken = new Set([
    ...handleDirectory.map((h) => h.handle.toLowerCase()),
    '@akovalev',
    '@teplo_remont',
  ]);
  return !taken.has(normalized);
}

const HANDLE_FORMAT_RE = /^[a-z0-9_]{3,32}$/;

/** POST /users/me/handle (apps.social, docs/tasks/
 * Задача_fix_web-profile-handle-real-api.md) — зеркалит РЕАЛЬНЫЙ
 * `apps.social.services.claim_handle`: 409 handle_taken / 422
 * invalid_handle_format, тот же формат `_HANDLE_RE` (`^[a-z0-9_]{3,32}$`,
 * регистр/«@» нормализуются так же). Синхронизирует ОБА места, где хендл
 * живёт на фронте — `me.handle` (верхнеуровневый, `CurrentUser`) И
 * `me.profiles[].handle` (`ActorProfile`, свежий person-профиль уже
 * существует к этому моменту — заведён при регистрации, `authGlobalDb.ts:
 * freshUser`, ADR-087 — не только «если профилей ещё нет», как было
 * раньше при неверном предположении о тайминге). */
export function claimHandle(value: string): CurrentUser {
  const normalized = value.trim().toLowerCase().replace(/^@/, '');
  if (!HANDLE_FORMAT_RE.test(normalized)) {
    throw new MockError(422, 'invalid_handle_format', 'Хендл — 3–32 символа: латиница в нижнем регистре, цифры, подчёркивание.');
  }
  const current = me.handle ? me.handle.replace(/^@/, '').toLowerCase() : null;
  if (normalized !== current && !isHandleAvailable(`@${normalized}`)) {
    throw new MockError(409, 'handle_taken', 'Этот хендл уже занят.');
  }
  const claimed = `@${normalized}`;
  const personProfile = me.profiles.find((p) => p.kind === 'person');
  me = {
    ...me,
    handle: claimed,
    profiles:
      personProfile !== undefined
        ? me.profiles.map((p) => (p.kind === 'person' ? { ...p, handle: claimed } : p))
        : [
            {
              id: `pf-${me.id}`,
              kind: 'person',
              display_name: me.display_name,
              handle: claimed,
              verification_level: me.verification_level,
              has_business_status: false,
            },
            ...me.profiles,
          ],
  };
  return me;
}

export function listSessions(): DeviceSession[] {
  return sessions;
}

export function logoutSession(id: string): void {
  const target = sessions.find((s) => s.id === id);
  if (target?.current) {
    throw new MockError(422, 'cannot_logout_current_here', 'Для этого устройства используйте выход из приложения.');
  }
  sessions = sessions.filter((s) => s.id !== id);
}

export function logoutAllSessions(): void {
  sessions = sessions.filter((s) => s.current);
}

// [Ф-решение] e2e-хуки: детерминированное состояние для сценариев, недостижимых
// через UI в скоупе DEV-02 (ЕСИА-флоу — заглушка, §11). Только мок, вызывается
// из Playwright через window.__mockDebug (mocks/browser.ts), в проде отсутствует.
export function debugSetVerificationLevel(level: OwnerVerificationLevel): void {
  me = { ...me, verificationLevel: level };
}
