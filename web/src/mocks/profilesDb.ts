/**
 * Мок-стор `apps.profiles.Profile` (city/remote/видимость/показ имени/аватара)
 * — docs/tasks/Задача_fix_web-profile-settings-real-api.md, ADR-087. ОТДЕЛЬНО
 * от `profileDb.ts` (`apps.accounts`-скоуп, `CurrentUser`): реальный бэк тоже
 * держит эти поля в другом приложении (`GET`/`PATCH /profiles/{id}`), не в
 * `/users/me`. Общий реестр по `id` — обслуживает и RU-моки (`data.ts`
 * `pf-person-1`/`pf-biz-1`/`pf-biz-2`), и GLOBAL (`authGlobalDb.ts`,
 * профиль заводится ПРИ РЕГИСТРАЦИИ — как подписчик `account.logged_in`
 * на боевом бэке, см. `backend/apps/profiles/subscriber.py`).
 */
import type { OwnerProfileSettings, ProfileKind } from '@porukam/core';
import { applyDemoEn, demoText, isDemoStore } from './demoEn';
import { workTypes } from './catalog';

/** ADR-190/191 — зеркало `apps.profiles.services.PROFILE_MAX_WORK_TYPES`. */
export const PROFILE_MAX_WORK_TYPES = 30;

export class ProfileWorkTypesInvalidError extends Error {}
export class ProfileWorkTypesLimitError extends Error {}
export class ProfileWorkTypeSphereNotDeclaredError extends Error {}

/** Зеркало `apps.profiles.services._normalize_work_type_codes` (ADR-190):
 * дубли схлопываются с сохранением порядка, каждый код — `<сфера>.<категория>`,
 * сфера обязана быть среди `allowedSphereCodes` (ИТОГОВЫЕ sphere_codes
 * профиля ПОСЛЕ этого же PATCH), а сама пара — реальный вид работ каталога
 * (мок-справочник `workTypes`, `catalog.ts`). */
function normalizeWorkTypeCodes(codes: string[], allowedSphereCodes: string[]): string[] {
  const unique: string[] = [];
  for (const raw of codes) {
    const code = (raw ?? '').trim();
    if (code && !unique.includes(code)) unique.push(code);
  }
  if (unique.length > PROFILE_MAX_WORK_TYPES) {
    throw new ProfileWorkTypesLimitError(`не больше ${PROFILE_MAX_WORK_TYPES} видов работ`);
  }
  const allowed = new Set(allowedSphereCodes);
  for (const composite of unique) {
    const dot = composite.indexOf('.');
    if (dot <= 0 || dot === composite.length - 1) {
      throw new ProfileWorkTypesInvalidError(`неверный формат вида работ: ${composite}`);
    }
    const sphereCode = composite.slice(0, dot);
    const categoryCode = composite.slice(dot + 1);
    if (!allowed.has(sphereCode)) {
      throw new ProfileWorkTypeSphereNotDeclaredError(`сфера «${sphereCode}» не заявлена в профиле — вид работ «${composite}» недоступен`);
    }
    if (!workTypes.some((w) => w.sphere_code === sphereCode && w.code === categoryCode)) {
      throw new ProfileWorkTypesInvalidError(`неизвестный вид работ: ${composite}`);
    }
  }
  return unique;
}

/** Дефолты — те же, что `apps.profiles.services.create_person_profile`
 * (видимость `link_and_deals` до явного согласия `profile_public`,
 * `show_name`/`avatar_visibility` открыты, ADR-059). `display_name: null` —
 * мок не знает имени лениво заведённого профиля (тот же принцип, что
 * реальный `ProfileSerializer.get_display_name` для профиля без имени). */
function defaultProfileSettings(id: string, kind: ProfileKind, displayName: string | null = null): OwnerProfileSettings {
  return {
    id,
    kind,
    display_name: displayName,
    profile_visibility: 'link_and_deals',
    hide_from_catalog: false,
    show_name: true,
    avatar_visibility: 'public',
    avatar_url: null,
    city_name: '',
    works_remotely: false,
    sphere_codes: [],
    work_type_codes: [],
  };
}

const registry = new Map<string, OwnerProfileSettings>();
/** Байты загруженного фото (ADR-103) — мок хранит исходник как есть, без
 * ресайза/WebP (это Pillow на бэке); `avatar_url` версионируется `v=`. */
const avatarBytes = new Map<string, { bytes: Uint8Array; type: string }>();
let avatarVersion = 0;

function seed(): void {
  registry.set('pf-person-1', {
    id: 'pf-person-1',
    kind: 'person',
    display_name: 'Годвин',
    profile_visibility: 'public',
    hide_from_catalog: false,
    show_name: true,
    avatar_visibility: 'public',
    avatar_url: null,
    city_name: 'Москва',
    works_remotely: false,
    sphere_codes: [],
    work_type_codes: [],
  });
  registry.set('pf-biz-1', defaultProfileSettings('pf-biz-1', 'business', 'ИП Годвин · «Тёплый ремонт»'));
  registry.set('pf-biz-2', defaultProfileSettings('pf-biz-2', 'business', 'СтройБыт'));
  // Контрагент для сид-договоров реального контура (Фаза 1, docs/tasks/
  // Промт_contracts-phase1-read-create.md) — realContractsDb.ts.
  // ОДНА личность на весь мок-контур: тот же человек ведёт объединения
  // (groupsHandlers), имеет карточку репутации и портфолио «Ванная под ключ»
  // (reputationHandlers/portfolioHandlers) и находится поиском по
  // `@marat_otdelkin`/Алматы. Раньше здесь была «Анна Кузнецова» из Казани, и
  // паспорт договора расходился с карточкой репутации того же profile_id
  // (хвосты 2026-08-25). Хендл в OwnerProfileSettings не хранится — он живёт в
  // reputation/groups-фикстурах, поэтому тут только имя и город.
  // `sphere_codes` пуст намеренно — как в карточке репутации: в поиске по
  // сфере он матчится `sphere_match: 'deals'`, а не заявленными сферами.
  registry.set('pf-mock-contractor-1', { ...defaultProfileSettings('pf-mock-contractor-1', 'person', 'Марат Отделкин'), city_name: 'Алматы' });
}
/**
 * Контрагенты английского демо-набора витрины (`demoEn.ts`). В русских моках
 * второй стороной ВСЕХ сид-договоров стоит одна личность (`pf-mock-contractor-1`)
 * — это осмысленно для тестов, но на витрине список сделок получался из восьми
 * строк с одним и тем же именем. Эти профили существуют ТОЛЬКО под флагом;
 * договорам их раздаёт `realContractsDb` (там же — какие сделки не трогаются).
 */
export const DEMO_EN_COUNTERPARTIES: [string, string, string][] = [
  ['pf-demo-en-2', 'Lucas Weber', 'Portland'],
  ['pf-demo-en-3', 'Sofia Rossi', 'Portland'],
  ['pf-demo-en-4', 'Noah Grant', 'Salem'],
  ['pf-demo-en-5', 'Ella Novak', 'Portland'],
  ['pf-demo-en-6', 'Adam Cole', 'Eugene'],
  ['pf-demo-en-7', 'Maria Silva', 'Portland'],
  ['pf-demo-en-8', 'Oliver Hart', 'Bend'],
];

/** Сид + английский демо-набор витрины (`demoEn.ts`) — без флага no-op. */
function seedAll(): void {
  seed();
  applyDemoEn(registry);
  if (isDemoStore()) {
    // В RU-наборе `demoText` отдаёт русских двойников английских имён и городов.
    for (const [id, name, city] of DEMO_EN_COUNTERPARTIES) {
      registry.set(id, { ...defaultProfileSettings(id, 'person', demoText(name)), city_name: demoText(city) });
    }
  }
}
seedAll();

export function resetProfilesDb(): void {
  registry.clear();
  avatarBytes.clear();
  seedAll();
}

export function setProfileAvatar(id: string, bytes: Uint8Array, type: string): OwnerProfileSettings {
  const current = ensureProfileSettings(id);
  avatarVersion += 1;
  avatarBytes.set(id, { bytes, type });
  const next = { ...current, avatar_url: `/v1/profiles/${id}/avatar?size=256&v=${avatarVersion}` };
  registry.set(id, next);
  return next;
}

export function removeProfileAvatar(id: string): OwnerProfileSettings {
  const current = ensureProfileSettings(id);
  avatarBytes.delete(id);
  const next = { ...current, avatar_url: null };
  registry.set(id, next);
  return next;
}

export function getProfileAvatar(id: string): { bytes: Uint8Array; type: string } | undefined {
  return avatarBytes.get(id);
}

/** GET /profiles/{id} — публичный на боевом бэке (docs — «тот же эндпоинт
 * видит гость по ссылке»); лениво заводит запись с дефолтами для ЛЮБОГО id,
 * которого ещё нет (свежий GLOBAL-профиль — тот же приём, что подписчик
 * apps.profiles на боевом бэке). */
export function ensureProfileSettings(id: string, kind: ProfileKind = 'person'): OwnerProfileSettings {
  const existing = registry.get(id);
  if (existing) return existing;
  const created = defaultProfileSettings(id, kind);
  registry.set(id, created);
  return created;
}

export function getProfileSettings(id: string): OwnerProfileSettings | undefined {
  return registry.get(id);
}

export type ProfileSettingsPatch = Partial<
  Pick<
    OwnerProfileSettings,
    'city_name' | 'works_remotely' | 'sphere_codes' | 'work_type_codes' | 'profile_visibility' | 'hide_from_catalog' | 'show_name' | 'avatar_visibility'
  >
>;

/** ADR-190/191: `work_type_codes` — та же пара инвариантов, что на бэке
 * (`apps.profiles.services.update_profile`):
 * - если `work_type_codes` передан в этом PATCH — валидируется ПРОТИВ
 *   ИТОГОВЫХ `sphere_codes` (переданных В ЭТОМ ЖЕ PATCH, если есть, иначе
 *   текущих);
 * - если `work_type_codes` НЕ передан, а `sphere_codes` сузили — осиротевшие
 *   виды работ (чья сфера выпала) обрезаются молча, без ошибки. */
export function patchProfileSettings(id: string, patch: ProfileSettingsPatch): OwnerProfileSettings {
  const current = ensureProfileSettings(id);
  const finalSphereCodes = patch.sphere_codes ?? current.sphere_codes;
  let workTypeCodes = current.work_type_codes;
  if (patch.work_type_codes !== undefined) {
    workTypeCodes = normalizeWorkTypeCodes(patch.work_type_codes, finalSphereCodes);
  } else if (patch.sphere_codes !== undefined) {
    workTypeCodes = current.work_type_codes.filter((code) => finalSphereCodes.includes(code.split('.')[0] ?? ''));
  }
  const next = { ...current, ...patch, work_type_codes: workTypeCodes };
  registry.set(id, next);
  return next;
}
