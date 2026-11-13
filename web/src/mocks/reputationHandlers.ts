import { http, HttpResponse } from 'msw';
import type {
  HandlePublic,
  ReputationCard,
  ReputationInsights,
  ReputationRoleStats,
} from '@porukam/core';
import { groupByHandle, publicGroupsOf } from './groupsHandlers';
import { applyDemoEn, isDemoStore } from './demoEn';

const BASE = '/v1';

function problem(status: number, code: string, detail: string) {
  return new HttpResponse(JSON.stringify({ status, code, title: code, detail }), {
    status,
    headers: { 'Content-Type': 'application/problem+json' },
  });
}

/**
 * Мок РЕАЛЬНОГО контракта репутации (ADR-076/093): `GET /v1/handles/{handle}`
 * (apps.social — `HandlePublicSerializer`, теперь с `profile_id`) и
 * `GET /v1/reputation/profiles/{id}/card` (apps.reputation —
 * `ReputationCardSerializer`). Ни одного поля сверх сериализаторов: рейтингов,
 * денежных объёмов, агрегатов по сферам и портфолио бэк не отдаёт, поэтому их
 * нет и здесь — иначе мок снова разъедется с боевым API.
 *
 * Сиды покрывают три состояния экрана: полная карточка со сделкой, полная
 * карточка без истории (новый профиль) и «стартовая» (`restricted`).
 */
const PROFILE_FULL = '018f1a00-0000-7000-8000-0000000000a1';
const PROFILE_EMPTY = '018f1a00-0000-7000-8000-0000000000a2';
const PROFILE_RESTRICTED = '018f1a00-0000-7000-8000-0000000000a3';
const PROFILE_COUNTERPARTY = '018f1a00-0000-7000-8000-0000000000a4';
/** Личный профиль владельца сессии (`mockUser.profiles[0]`) — «Как гость» с `/me`
 * ведёт на `/@godwin`, и без этого сида предпросмотр собственной карточки
 * упирался в «Такой страницы нет». */
const PROFILE_ME = 'pf-person-1';


const EMPTY_RATIO = { done: 0, total: 0 };

/** Пустой блок роли: у профиля без сделок в этой роли ВСЕ доли — 0/0
 * («нечего мерить», не «плохо», ADR-163 §2). */
function emptyRole(): ReputationRoleStats {
  return {
    deals: 0,
    first_time: { ...EMPTY_RATIO },
    disputes_free: { ...EMPTY_RATIO },
    disputes_opened: 0,
    disputes_resolved: 0,
    on_time_delivery: { ...EMPTY_RATIO },
    on_time_payment: { ...EMPTY_RATIO },
    prompt_acceptance: { ...EMPTY_RATIO },
    warranty_claims: 0,
  };
}

/** Агрегаты пустого (но полного) профиля. `restricted`-карточка получает
 * `null`/`[]` — производные от списка сделок скрыты вместе с ним. */
const EMPTY_AGGREGATES = {
  by_role: { contractor: emptyRole(), customer: emptyRole() },
  by_sphere: [],
  disputes_free: { ...EMPTY_RATIO },
  repeat_counterparties: { count: 0, total: 0 },
  last_deal_at: null,
} satisfies Pick<
  ReputationCard,
  'by_role' | 'by_sphere' | 'disputes_free' | 'repeat_counterparties' | 'last_deal_at'
>;

const RESTRICTED_AGGREGATES = {
  by_role: null,
  by_sphere: [],
  disputes_free: null,
  repeat_counterparties: null,
  last_deal_at: null,
} satisfies Pick<
  ReputationCard,
  'by_role' | 'by_sphere' | 'disputes_free' | 'repeat_counterparties' | 'last_deal_at'
>;

export const reputationHandleSeeds: Record<string, HandlePublic> = {
  akovalev: { handle: 'akovalev', kind: 'user', verified: true, profile_id: PROFILE_FULL },
  godwin: { handle: 'godwin', kind: 'user', verified: false, profile_id: PROFILE_ME },
  novichok: { handle: 'novichok', kind: 'user', verified: false, profile_id: PROFILE_EMPTY },
  zakrytyi: { handle: 'zakrytyi', kind: 'user', verified: false, profile_id: PROFILE_RESTRICTED },
  // Хендл объединения без карточки (легаси-сид; живые группы разрешаются ниже через groupByHandle).
  teplo_remont: { handle: 'teplo_remont', kind: 'group', verified: false, profile_id: null, group_id: null, group_name: null },
};

export const reputationCardSeeds: Record<string, ReputationCard> = {
  // Профиль мок-исполнителя (моки договоров/поиска/портфолио ключуются этим id):
  // карточка нужна, чтобы сид портфолио «Ванная под ключ» было где показать.
  'pf-mock-contractor-1': {
    profile_id: 'pf-mock-contractor-1',
    kind: 'person',
    display_name: 'Марат Отделкин',
    handle: 'marat_otdelkin',
    avatar_url: null,
    profile_age_days: 200,
    created_at: '2026-02-05T10:00:00Z',
    restricted: false,
    deals_count: 0,
    counterparties_count: 0,
    deals: [],
    groups: [],
    sphere_codes: [],
    ...EMPTY_AGGREGATES,
  },
  // Карточка владельца сессии: режим «как гость» показывает ровно её.
  [PROFILE_ME]: {
    profile_id: PROFILE_ME,
    kind: 'person',
    display_name: 'Годвин',
    handle: 'godwin',
    avatar_url: null,
    profile_age_days: 120,
    created_at: '2026-04-20T10:00:00Z',
    restricted: false,
    deals_count: 0,
    counterparties_count: 0,
    deals: [],
    groups: [],
    sphere_codes: [],
    ...EMPTY_AGGREGATES,
  },
  [PROFILE_FULL]: {
    profile_id: PROFILE_FULL,
    kind: 'person',
    display_name: 'Артём Ковалёв',
    handle: 'akovalev',
    avatar_url: null,
    profile_age_days: 512,
    created_at: '2025-03-20T10:00:00Z',
    restricted: false,
    // Счётчики плиток — АГРЕГАТЫ по всей карточке, а не длина списка `deals`
    // (в нём лежат только ПОСЛЕДНИЕ сделки). Держим их согласованными с сидом:
    // 39 (исполнитель) + 6 (заказчик) = 45 = total у `disputes_free`,
    // 17 контрагентов = total у `repeat_counterparties`.
    deals_count: 45,
    counterparties_count: 17,
    deals: [
      {
        contract_id: '018f1a00-0000-7000-8000-0000000000c1',
        contract_type_code: 'services_repair',
        segment: 'free_c2c',
        sphere_codes: ['repair'],
        period_start: '2026-05-04T09:00:00Z',
        period_end: '2026-06-01T18:00:00Z',
        completed_at: '2026-06-02T12:00:00Z',
        outcome: 'completed',
        milestones_accepted: 3,
        milestones_rejected: 1,
        disputes_opened: 0,
        disputes_resolved: 0,
        counterparty: { profile_id: PROFILE_COUNTERPARTY, role: 'customer' },
      },
    ],
    groups: [{ id: 'grp-1', name: 'Мастера отделки', kind: 'guild', handle: 'masters_otdelki' }],
    sphere_codes: ['plumbing'],
    // Сид под макет 05.09: профиль по ОБЕ стороны сделок — по нему видно,
    // что оси ролей не складываются (у исполнителя «сделано в срок», у
    // заказчика «оплачено в срок»), и что одна сфера даёт две строки.
    by_role: {
      contractor: {
        deals: 39,
        first_time: { done: 35, total: 39 },
        disputes_free: { done: 38, total: 39 },
        disputes_opened: 1,
        disputes_resolved: 1,
        on_time_delivery: { done: 36, total: 39 },
        on_time_payment: { ...EMPTY_RATIO },
        prompt_acceptance: { ...EMPTY_RATIO },
        warranty_claims: 2,
      },
      customer: {
        deals: 6,
        first_time: { done: 6, total: 6 },
        disputes_free: { done: 6, total: 6 },
        disputes_opened: 0,
        disputes_resolved: 0,
        on_time_delivery: { ...EMPTY_RATIO },
        on_time_payment: { done: 3, total: 6 },
        prompt_acceptance: { done: 5, total: 6 },
        warranty_claims: 0,
      },
    },
    by_sphere: [
      {
        sphere_code: 'repair',
        role: 'contractor',
        deals: 30,
        first_time: { done: 28, total: 31 },
        disputes: 1,
        warranty: 2,
        on_time: { done: 29, total: 31 },
      },
      {
        sphere_code: 'plumbing',
        role: 'contractor',
        deals: 9,
        first_time: { done: 7, total: 8 },
        disputes: 0,
        warranty: 0,
        on_time: { done: 3, total: 8 },
      },
      {
        sphere_code: 'repair',
        role: 'customer',
        deals: 6,
        first_time: { done: 6, total: 6 },
        disputes: 0,
        warranty: 0,
        on_time: { done: 3, total: 6 },
      },
    ],
    disputes_free: { done: 44, total: 45 },
    repeat_counterparties: { count: 4, total: 17 },
    last_deal_at: '2026-06-02T12:00:00Z',
  },
  [PROFILE_EMPTY]: {
    profile_id: PROFILE_EMPTY,
    kind: 'person',
    display_name: null,
    handle: 'novichok',
    avatar_url: null,
    profile_age_days: 2,
    created_at: '2026-08-16T08:00:00Z',
    restricted: false,
    deals_count: 0,
    counterparties_count: 0,
    deals: [],
    groups: [],
    sphere_codes: [],
    ...EMPTY_AGGREGATES,
  },
  [PROFILE_RESTRICTED]: {
    profile_id: PROFILE_RESTRICTED,
    kind: 'person',
    display_name: 'Пётр Закрытый',
    handle: 'zakrytyi',
    avatar_url: null,
    profile_age_days: 300,
    created_at: '2025-10-22T08:00:00Z',
    restricted: true,
    deals_count: null,
    counterparties_count: null,
    deals: [],
    groups: [],
    sphere_codes: [],
    ...RESTRICTED_AGGREGATES,
  },
  [PROFILE_COUNTERPARTY]: {
    profile_id: PROFILE_COUNTERPARTY,
    kind: 'person',
    display_name: 'Мария Заказчикова',
    handle: null,
    avatar_url: null,
    profile_age_days: 430,
    created_at: '2025-06-14T08:00:00Z',
    restricted: false,
    deals_count: 1,
    counterparties_count: 1,
    deals: [],
    groups: [],
    sphere_codes: [],
    ...EMPTY_AGGREGATES,
  },
};

/**
 * `GET /v1/reputation/profiles/{id}/insights` — ПРИВАТНО владельцу
 * (ADR-163 §8). В моке право не проверяется (мок-стенд знает одного
 * пользователя), но набор данных ровно тот, что отдаёт бэк: раскрытие
 * метрик в конкретные этапы, «до зелёной зоны осталось N» и блок
 * «считается, но не показывается другим».
 */
function insightsFor(profileId: string): ReputationInsights {
  return {
    profile_id: profileId,
    generated_at: '2026-09-05T09:00:00Z',
    deals: 45,
    counterparties: 17,
    recent: { deals: 2, counterparties: 1, rejections: 1 },
    metrics: [
      {
        code: 'on_time_delivery',
        role: 'contractor',
        done: 36,
        total: 39,
        to_green: null,
        items: [
          {
            contract_id: '018f1a00-0000-7000-8000-0000000000c1',
            milestone_id: '018f1a00-0000-7000-8000-0000000000m1',
            title: 'Штукатурка стен',
            sphere_code: 'repair',
            ok: false,
            detail: '',
            happened_at: '2026-05-20T10:00:00Z',
          },
        ],
      },
      {
        code: 'on_time_payment',
        role: 'customer',
        done: 3,
        total: 6,
        to_green: 6,
        items: [
          {
            contract_id: '018f1a00-0000-7000-8000-0000000000c2',
            milestone_id: '018f1a00-0000-7000-8000-0000000000m2',
            title: 'Замер и смета',
            sphere_code: 'repair',
            ok: false,
            detail: '',
            happened_at: '2026-04-11T10:00:00Z',
          },
        ],
      },
      {
        code: 'prompt_acceptance',
        role: 'customer',
        done: 5,
        total: 6,
        to_green: null,
        items: [
          {
            contract_id: '018f1a00-0000-7000-8000-0000000000c2',
            milestone_id: '018f1a00-0000-7000-8000-0000000000m3',
            title: 'Демонтаж',
            sphere_code: 'repair',
            ok: false,
            detail: 'auto_accepted',
            happened_at: '2026-04-25T10:00:00Z',
          },
        ],
      },
      {
        code: 'first_time',
        role: 'contractor',
        done: 35,
        total: 39,
        to_green: null,
        items: [
          {
            contract_id: '018f1a00-0000-7000-8000-0000000000c1',
            milestone_id: '018f1a00-0000-7000-8000-0000000000m1',
            title: 'Штукатурка стен',
            sphere_code: 'repair',
            ok: false,
            detail: 'Швы не затёрты по всей длине',
            happened_at: '2026-05-18T10:00:00Z',
          },
        ],
      },
    ],
    hidden: {
      volume: [{ amount: '4820000.00', currency: 'RUB' }],
      protected_payments: { done: 12, total: 45 },
    },
  };
}

export const reputationInsightsSeeds: Record<string, ReputationInsights> = {
  [PROFILE_FULL]: insightsFor(PROFILE_FULL),
  // Профиль залогиненного мок-пользователя (`data.ts::mockUser`) — вход в
  // разбор идёт из `/me`, а активный актёр там именно он.
  'pf-person-1': insightsFor('pf-person-1'),
};

/** Английский демо-набор витрины (`demoEn.ts`) — подменяет имена/названия в
 * карточках репутации; ключи реестров (id профилей, хендлы) не трогаются.
 * Без флага — no-op. */
applyDemoEn(reputationHandleSeeds);
applyDemoEn(reputationCardSeeds);
if (isDemoStore()) {
  // Хендл переехал в значении (`akovalev` → `adam_cole`), а адресуются по ключу:
  // заводим псевдоним под новое написание, СТАРЫЙ ключ оставляем — по нему ходят
  // ссылки внутри моков и существующие e2e.
  for (const entry of Object.values(reputationHandleSeeds)) {
    if (!reputationHandleSeeds[entry.handle]) reputationHandleSeeds[entry.handle] = entry;
  }
}

export const reputationHandlers = [
  http.get(`${BASE}/handles/:handle`, ({ params }) => {
    const handle = String(params.handle ?? '').replace(/^@/, '');
    const entry = reputationHandleSeeds[handle];
    if (entry) return HttpResponse.json(entry);
    // ADR-117 §6: хендл объединения → group_id/group_name (маршрут /@хендл ведёт на карточку).
    const group = groupByHandle(handle);
    if (group) {
      return HttpResponse.json({ handle, kind: 'group', verified: false, profile_id: null, group_id: group.id, group_name: group.name } satisfies HandlePublic);
    }
    return problem(404, 'not_found', 'Хендл не найден.');
  }),

  http.get(`${BASE}/reputation/profiles/:profileId/insights`, ({ params }) => {
    const insights = reputationInsightsSeeds[String(params.profileId ?? '')];
    if (!insights) return problem(404, 'not_found', 'Профиль не найден.');
    return HttpResponse.json(insights);
  }),

  http.get(`${BASE}/reputation/profiles/:profileId/card`, ({ params }) => {
    const card = reputationCardSeeds[String(params.profileId ?? '')];
    if (!card) return problem(404, 'not_found', 'Профиль не найден.');
    // Живые членства из мок-стора групп (ADR-117 §7) поверх статического сида.
    const live = publicGroupsOf(card.profile_id);
    return HttpResponse.json(live.length > 0 ? { ...card, groups: live } : card);
  }),
];
