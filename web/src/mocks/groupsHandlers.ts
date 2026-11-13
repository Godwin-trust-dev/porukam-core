import { http, HttpResponse } from 'msw';
import type { Group, GroupMemberRow, SearchResponse } from '@porukam/core';
import { parseMultipart } from './multipart';
import { getProfileSettings } from './profilesDb';
import { getSearchCatalogPage } from './catalogSearchDb';
import { viewerLocale } from './geoHandlers';

const BASE = '/v1';

function problem(status: number, code: string, detail: string) {
  return new HttpResponse(JSON.stringify({ status, code, title: code, detail }), {
    status,
    headers: { 'Content-Type': 'application/problem+json' },
  });
}

function actor(request: Request): string | null {
  return request.headers.get('X-Acting-Profile');
}

function authed(request: Request): boolean {
  return Boolean(request.headers.get('Authorization')?.startsWith('Bearer '));
}

/** Мок apps.social groups v2 (ADR-117) + /dashboard/search (ADR-114): in-memory
 * зеркало join_policy/заявок/хендлов/логотипа. «Пользователь» в моке =
 * профиль актёра. Чтение — публичное (AllowAny), как на бэке: гость видит
 * только `is_public`, приватное — 404. */
interface MemberRecord {
  id: number;
  member: string;
  member_name: string | null;
  member_handle: string | null;
  member_profile_id: string | null;
  role: GroupMemberRow['role'];
  status: GroupMemberRow['status'];
  joined_at: string | null;
}
interface GroupRecord extends Omit<Group, 'my_membership' | 'members_count'> {
  memberships: MemberRecord[];
}

let seq = 0;
const groups: GroupRecord[] = [];
/** Занятые хендлы объединений (без «@»); пользовательские — в profileHandlers. */
const USER_HANDLES = new Set(['marat_otdelkin', 'akovalev', 'novichok', 'zakrytyi']);

export function resetGroups(): void {
  groups.length = 0;
  seq = 0;
  seedGroups();
}

function seedGroups(): void {
  groups.push(
    {
      id: 'grp-1',
      kind: 'guild',
      leader: 'u-2001',
      leader_name: 'Марат Отделкин',
      name: 'Мастера отделки',
      description: 'Плитка, стяжка, электрика — обмен заказами.',
      sphere_code: 'repair',
      geo_scope: 'city',
      country_code: 'KZ',
      city_name: 'Алматы',
      links: [{ url: 'https://t.me/masters_otdelki', label: 'Telegram' }],
      logo_url: null,
      is_public: true,
      join_policy: 'open',
      reputation_mode: 'aggregate_only',
      handle: '@masters_otdelki',
      created_at: '2026-08-01T10:00:00Z',
      memberships: [
        { id: 1, member: 'pf-mock-contractor-1', member_name: 'Марат Отделкин', member_handle: '@marat_otdelkin', member_profile_id: 'pf-mock-contractor-1', role: 'leader', status: 'active', joined_at: '2026-08-01T10:00:00Z' },
      ],
    },
    {
      id: 'grp-2',
      kind: 'clan',
      leader: 'u-2001',
      leader_name: 'Марат Отделкин',
      name: 'Закрытый клуб сантехников',
      description: 'Вход по подтверждению.',
      sphere_code: '',
      geo_scope: 'world',
      country_code: '',
      city_name: '',
      links: [],
      logo_url: null,
      is_public: true,
      join_policy: 'approval',
      reputation_mode: 'aggregate_only',
      handle: '@santeh_club',
      created_at: '2026-08-02T10:00:00Z',
      memberships: [
        { id: 2, member: 'pf-mock-contractor-1', member_name: 'Марат Отделкин', member_handle: '@marat_otdelkin', member_profile_id: 'pf-mock-contractor-1', role: 'leader', status: 'active', joined_at: '2026-08-02T10:00:00Z' },
      ],
    },
    // ADR-129: объединение, которым руководит САМ демо-пользователь
    // (`pf-person-1`) — без него контекст актёра-объединения нечем показать:
    // в шапке нет ни одной управляемой строки, и раздел настроек недостижим.
    {
      id: 'grp-3',
      kind: 'clan',
      leader: 'u-1001',
      leader_name: 'Годвин',
      name: 'Мебельная артель',
      description: 'Мебель под заказ и сборка: общий адрес и общая карточка.',
      sphere_code: 'furniture',
      geo_scope: 'city',
      country_code: 'KZ',
      city_name: 'Алматы',
      links: [],
      logo_url: null,
      is_public: true,
      join_policy: 'approval',
      reputation_mode: 'aggregate_only',
      handle: '@mebel_artel',
      created_at: '2026-08-05T10:00:00Z',
      memberships: [
        { id: 3, member: 'pf-person-1', member_name: 'Годвин', member_handle: '@godwin', member_profile_id: 'pf-person-1', role: 'leader', status: 'active', joined_at: '2026-08-05T10:00:00Z' },
        { id: 4, member: 'pf-mock-contractor-1', member_name: 'Марат Отделкин', member_handle: '@marat_otdelkin', member_profile_id: 'pf-mock-contractor-1', role: 'member', status: 'active', joined_at: '2026-08-06T10:00:00Z' },
      ],
    },
  );
}

seedGroups();

/** Группы, в которых профиль состоит активно (для карточки репутации — ADR-117 §7). */
export function publicGroupsOf(profileId: string): { id: string; name: string; kind: string; handle: string | null }[] {
  return groups
    .filter((g) => g.is_public && g.memberships.some((m) => m.member === profileId && m.status === 'active'))
    .map((g) => ({ id: g.id, name: g.name, kind: g.kind, handle: g.handle?.replace(/^@/, '') ?? null }));
}

export function groupByHandle(handle: string): GroupRecord | undefined {
  return groups.find((g) => g.handle === `@${handle.replace(/^@/, '').toLowerCase()}`);
}

function serialize(g: GroupRecord, viewer: string | null): Group {
  const mine = viewer ? g.memberships.find((m) => m.member === viewer && m.status !== 'left') : undefined;
  const { memberships: _m, ...rest } = g;
  return {
    ...rest,
    members_count: g.memberships.filter((m) => m.status === 'active').length,
    my_membership: mine ? { role: mine.role, status: mine.status } : null,
  };
}

function visible(g: GroupRecord | undefined, viewer: string | null): GroupRecord | undefined {
  if (!g) return undefined;
  if (g.is_public) return g;
  return viewer && g.memberships.some((m) => m.member === viewer && m.status !== 'left') ? g : undefined;
}

/** ADR-173: фото участника — из его профиля (в сиде картинок нет, `null`,
 * пока фото не загрузят через `/profiles/{id}/avatar`). */
const rows = (g: GroupRecord): GroupMemberRow[] =>
  g.memberships
    .filter((m) => m.status !== 'left')
    .map((m) => ({ ...m, member_avatar_url: (m.member_profile_id && getProfileSettings(m.member_profile_id)?.avatar_url) || null }));

function manages(g: GroupRecord, viewer: string | null): boolean {
  const m = viewer ? g.memberships.find((x) => x.member === viewer) : undefined;
  return !!m && m.status === 'active' && (m.role === 'leader' || m.role === 'admin');
}

function validHandle(value: string): boolean {
  return /^[a-z0-9_]{3,20}$/i.test(value);
}

function handleTaken(value: string, except?: string): boolean {
  const v = value.toLowerCase();
  return USER_HANDLES.has(v) || groups.some((g) => g.id !== except && g.handle === `@${v}`);
}

export const groupsHandlers = [
  http.get(`${BASE}/groups`, ({ request }) => {
    const viewer = authed(request) ? actor(request) : null;
    return HttpResponse.json(groups.filter((g) => g.is_public).map((g) => serialize(g, viewer)));
  }),
  http.post(`${BASE}/groups`, async ({ request }) => {
    if (!authed(request)) return problem(401, 'unauthorized', 'Нужен вход.');
    const body = (await request.json()) as Partial<Omit<Group, 'id'>> & { handle?: string; name: string };
    const handle = (body.handle ?? '').replace(/^@/, '');
    if (!handle) return problem(422, 'invalid_request', 'handle обязателен.');
    if (!validHandle(handle)) return problem(422, 'invalid_handle', 'Неверный формат хендла.');
    if (handleTaken(handle)) return problem(409, 'handle_taken', 'Хендл занят.');
    if (!body.sphere_code) return problem(422, 'invalid_sphere', 'Неизвестная сфера.');
    const scope = body.geo_scope ?? 'world';
    if ((scope === 'country' && !body.country_code) || (scope === 'city' && (!body.country_code || !body.city_name))) {
      return problem(422, 'invalid_geo', 'Для страны нужна страна, для города — страна и город.');
    }
    seq += 1;
    const me = actor(request) ?? 'pf-person-1';
    const record: GroupRecord = {
      id: `grp-n-${seq}`,
      kind: body.kind ?? 'clan',
      leader: me,
      leader_name: 'Годвин',
      name: body.name,
      description: body.description ?? '',
      sphere_code: body.sphere_code,
      geo_scope: scope,
      country_code: body.country_code ?? '',
      city_name: body.city_name ?? '',
      links: body.links ?? [],
      logo_url: null,
      is_public: body.is_public ?? true,
      join_policy: body.join_policy ?? 'open',
      reputation_mode: 'aggregate_only',
      handle: `@${handle.toLowerCase()}`,
      created_at: new Date().toISOString(),
      memberships: [{ id: 1000 + seq, member: me, member_name: 'Годвин', member_handle: '@godwin', member_profile_id: me, role: 'leader', status: 'active', joined_at: new Date().toISOString() }],
    };
    groups.push(record);
    return HttpResponse.json(serialize(record, me), { status: 201 });
  }),
  http.get(`${BASE}/groups/:id`, ({ request, params }) => {
    const viewer = authed(request) ? actor(request) : null;
    const g = visible(groups.find((x) => x.id === params.id), viewer);
    if (!g) return problem(404, 'not_found', 'Объединение не найдено.');
    return HttpResponse.json(serialize(g, viewer));
  }),
  http.patch(`${BASE}/groups/:id`, async ({ request, params }) => {
    if (!authed(request)) return problem(401, 'unauthorized', 'Нужен вход.');
    const viewer = actor(request);
    const g = groups.find((x) => x.id === params.id);
    if (!g) return problem(404, 'not_found', 'Объединение не найдено.');
    if (!manages(g, viewer)) return problem(403, 'permission_denied', 'Только лидер или администратор.');
    const patch = (await request.json()) as Partial<Group>;
    const scope = patch.geo_scope ?? g.geo_scope;
    const country = patch.country_code ?? g.country_code;
    const city = patch.city_name ?? g.city_name;
    if ((scope === 'country' && !country) || (scope === 'city' && (!country || !city))) {
      return problem(422, 'invalid_geo', 'Для страны нужна страна, для города — страна и город.');
    }
    Object.assign(g, patch, { id: g.id, leader: g.leader, handle: g.handle, logo_url: g.logo_url });
    return HttpResponse.json(serialize(g, viewer));
  }),
  http.post(`${BASE}/groups/:id/logo`, async ({ request, params }) => {
    if (!authed(request)) return problem(401, 'unauthorized', 'Нужен вход.');
    const viewer = actor(request);
    const g = groups.find((x) => x.id === params.id);
    if (!g) return problem(404, 'not_found', 'Объединение не найдено.');
    if (!manages(g, viewer)) return problem(403, 'permission_denied', 'Только лидер или администратор.');
    // `parseMultipart`, а не `request.formData()`: в vitest+jsdom встроенный
    // парсер падает на подменённом классе `File` (см. `./multipart.ts`) —
    // тот же приём, что в загрузке аватара и доказательств.
    const parsed = await parseMultipart(request);
    const file = parsed?.files['file'];
    if (!file) return problem(422, 'invalid_logo_image', 'Нужен файл изображения.');
    if (file.size > 5 * 1024 * 1024) return problem(413, 'logo_too_large', 'Файл больше 5 МБ.');
    if (!file.type.startsWith('image/')) return problem(422, 'invalid_logo_image', 'Это не изображение.');
    seq += 1;
    g.logo_url = `${BASE}/groups/${g.id}/logo?size=256&v=mock${seq}`;
    return HttpResponse.json(serialize(g, viewer));
  }),
  http.delete(`${BASE}/groups/:id/logo`, ({ request, params }) => {
    if (!authed(request)) return problem(401, 'unauthorized', 'Нужен вход.');
    const viewer = actor(request);
    const g = groups.find((x) => x.id === params.id);
    if (!g) return problem(404, 'not_found', 'Объединение не найдено.');
    if (!manages(g, viewer)) return problem(403, 'permission_denied', 'Только лидер или администратор.');
    g.logo_url = null;
    return HttpResponse.json(serialize(g, viewer));
  }),
  http.get(`${BASE}/groups/:id/members`, ({ request, params }) => {
    const viewer = authed(request) ? actor(request) : null;
    const g = visible(groups.find((x) => x.id === params.id), viewer);
    if (!g) return problem(404, 'not_found', 'Объединение не найдено.');
    // Заявки видит только лидер/админ (ADR-117 §6).
    const all = rows(g);
    return HttpResponse.json(manages(g, viewer) ? all : all.filter((m) => m.status === 'active'));
  }),
  http.post(`${BASE}/groups/:id/join`, ({ request, params }) => {
    if (!authed(request)) return problem(401, 'unauthorized', 'Нужен вход.');
    const g = groups.find((x) => x.id === params.id);
    if (!g) return problem(404, 'not_found', 'Объединение не найдено.');
    const me = actor(request) ?? 'pf-person-1';
    let m = g.memberships.find((x) => x.member === me);
    const now = new Date().toISOString();
    if (m && m.status === 'invited') {
      m.status = 'active';
      m.joined_at = now;
    } else if (!m || m.status === 'left') {
      const status = g.join_policy === 'open' ? 'active' : 'requested';
      if (m) {
        m.status = status;
        m.joined_at = status === 'active' ? now : null;
      } else {
        seq += 1;
        m = { id: 2000 + seq, member: me, member_name: 'Годвин', member_handle: '@godwin', member_profile_id: me, role: 'member', status, joined_at: status === 'active' ? now : null };
        g.memberships.push(m);
      }
    }
    return HttpResponse.json({ ...m! });
  }),
  http.post(`${BASE}/groups/:id/leave`, ({ request, params }) => {
    const g = groups.find((x) => x.id === params.id);
    if (!g) return problem(404, 'not_found', 'Объединение не найдено.');
    const m = g.memberships.find((x) => x.member === actor(request));
    if (m?.role === 'leader') return problem(409, 'leader_cannot_leave', 'Лидер не может выйти из объединения.');
    if (m) m.status = 'left';
    return new HttpResponse(null, { status: 204 });
  }),
  http.post(`${BASE}/groups/:id/requests/:mid/:decision`, ({ params }) => {
    const g = groups.find((x) => x.id === params.id);
    const m = g?.memberships.find((x) => x.id === Number(params.mid));
    if (!g || !m) return problem(404, 'not_found', 'Заявка не найдена.');
    if (m.status !== 'requested') return problem(409, 'join_request_not_pending', 'Заявка уже решена.');
    if (params.decision === 'approve') {
      m.status = 'active';
      m.joined_at = new Date().toISOString();
    } else {
      m.status = 'left';
    }
    return HttpResponse.json({ ...m });
  }),
  http.post(`${BASE}/groups/:id/members`, async ({ request, params }) => {
    const g = groups.find((x) => x.id === params.id);
    if (!g) return problem(404, 'not_found', 'Объединение не найдено.');
    const body = (await request.json()) as { handle?: string };
    seq += 1;
    const handle = (body.handle ?? '').replace('@', '');
    const m: MemberRecord = { id: 3000 + seq, member: `pf-invited-${seq}`, member_name: handle || null, member_handle: handle ? `@${handle}` : null, member_profile_id: null, role: 'member', status: 'invited', joined_at: null };
    g.memberships.push(m);
    return HttpResponse.json({ ...m }, { status: 201 });
  }),
  http.post(`${BASE}/groups/:id/handle`, async ({ request, params }) => {
    const g = groups.find((x) => x.id === params.id);
    if (!g) return problem(404, 'not_found', 'Объединение не найдено.');
    if (!manages(g, actor(request))) return problem(403, 'permission_denied', 'Только лидер или администратор.');
    const body = (await request.json()) as { value: string };
    const value = body.value.replace('@', '');
    if (!validHandle(value)) return problem(422, 'invalid_handle', 'Неверный формат хендла.');
    if (handleTaken(value, g.id)) return problem(409, 'handle_taken', 'Хендл занят.');
    g.handle = `@${value.toLowerCase()}`;
    return HttpResponse.json(serialize(g, actor(request)));
  }),
  // ADR-114: поиск — люди (мок: одна персона по хендлу/телефону) + группы.
  // `catalog` (план 11.09 §6, ADR-184/185) — НЕЗАВИСИМАЯ ветка того же
  // ответа: считается, только если запрошен хоть один из её параметров
  // (тот же список, что `apps.dashboards.api.views._catalog_requested`),
  // иначе приходит пустой — зеркалим это в моке, чтобы e2e/ручная проверка
  // видели то же поведение, что реальный бэк.
  http.get(`${BASE}/dashboard/search`, ({ request }) => {
    if (!authed(request)) return problem(401, 'unauthorized', 'Нужен вход.');
    const url = new URL(request.url);
    const q = (url.searchParams.get('q') ?? '').trim().toLowerCase();
    const zone = (url.searchParams.get('zone') as SearchResponse['applied_zone']) || 'city';

    let data: SearchResponse;
    if (q.length < 2) {
      data = { applied_zone: zone, profiles: [], groups: [] };
    } else {
      const digits = q.replace(/\D/g, '');
      const people: SearchResponse['profiles'] =
        '@марат отделкин'.includes(q) || 'marat_otdelkin'.startsWith(q.replace('@', '')) || (digits.length >= 10 && '79990002001'.endsWith(digits.slice(-10)))
          ? [{ profile_id: 'pf-mock-contractor-1', handle: '@marat_otdelkin', display_name: 'Марат Отделкин', city_name: 'Алматы' }]
          : [];
      // ADR-121: сфера из текста запроса (мок: два слова каталога) → люди по
      // сделкам в сфере и объединения по sphere_code.
      const SPHERES: Record<string, { code: string; name: string; words: string[] }> = {
        repair: { code: 'repair', name: 'Ремонт и строительство', words: ['ремонт', 'плитк', 'отделк', 'стройк'] },
        beauty: { code: 'beauty', name: 'Красота', words: ['красот', 'маникюр', 'ногт'] },
      };
      const spheres = digits.length >= 10 ? [] : Object.values(SPHERES).filter((s) => s.words.some((w) => q.includes(w))).map(({ code, name }) => ({ code, name }));
      const sphereCodes = new Set(spheres.map((s) => s.code));
      if (sphereCodes.has('repair') && !people.some((p) => p.profile_id === 'pf-mock-contractor-1')) {
        people.push({ profile_id: 'pf-mock-contractor-1', handle: '@marat_otdelkin', display_name: 'Марат Отделкин', city_name: 'Алматы', sphere_match: 'deals' });
      }
      const matchedGroups = groups
        .filter((g) => g.is_public && (g.name.toLowerCase().includes(q) || (g.handle ?? '').toLowerCase().startsWith(q.startsWith('@') ? q : `@${q}`) || sphereCodes.has(g.sphere_code)))
        .map((g) => ({ id: g.id, name: g.name, kind: g.kind, join_policy: g.join_policy, handle: g.handle, members_count: g.memberships.filter((m) => m.status === 'active').length, sphere_code: g.sphere_code }));
      data = { applied_zone: zone, profiles: people, groups: matchedGroups, spheres };
    }

    const sphereParams = url.searchParams.getAll('sphere').map((s) => s.trim()).filter(Boolean);
    // ADR-190/191: `work_type` — тот же повторяемый параметр, что `sphere`,
    // его присутствие тоже включает ветку `catalog` (тот же приём, что
    // `apps.dashboards.api.views._catalog_requested`).
    const workTypeParams = url.searchParams.getAll('work_type').map((s) => s.trim()).filter(Boolean);
    const catalogFlagParams = ['catalog', 'country', 'region', 'city', 'experience_min', 'has_experience', 'cursor'];
    const catalogRequested = sphereParams.length > 0 || workTypeParams.length > 0 || catalogFlagParams.some((name) => (url.searchParams.get(name) ?? '').trim());
    if (!catalogRequested) {
      data.catalog = { items: [], next_cursor: null };
      return HttpResponse.json(data);
    }

    const rawMinExperience = url.searchParams.get('experience_min');
    let minExperience = rawMinExperience ? Number.parseInt(rawMinExperience, 10) : null;
    const hasExperience = ['1', 'true', 'yes'].includes((url.searchParams.get('has_experience') ?? '').toLowerCase());
    if (hasExperience) minExperience = Math.max(minExperience ?? 0, 1);
    const rawLimit = url.searchParams.get('limit');
    const limit = rawLimit ? Math.min(Math.max(Number.parseInt(rawLimit, 10) || 20, 1), 50) : 20;
    const cityParam = url.searchParams.get('city');

    data.catalog = getSearchCatalogPage({
      country: url.searchParams.get('country'),
      region: url.searchParams.get('region'),
      city: cityParam ? Number.parseInt(cityParam, 10) || null : null,
      sphereCodes: sphereParams,
      workTypeCodes: workTypeParams,
      minExperience,
      limit,
      cursor: url.searchParams.get('cursor'),
      locale: viewerLocale(request),
    });
    return HttpResponse.json(data);
  }),
];
