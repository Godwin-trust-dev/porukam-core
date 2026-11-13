/**
 * Мок-стор ленты уведомлений (DEV-14): личный эндпоинт (Bearer, без X-Acting-Profile) —
 * лента принадлежит владельцу ЛК, а не профилю-актёру сделки, симметрично `/users/me`.
 * `group` (сегодня/вчера/ранее) и счётчики по группам-фильтрам — вычисляются на чтении
 * от `created_at` (тот же приём sweep-on-read, что `archiveDb`/`paymentsDb`, §3 CLAUDE.md),
 * не хранятся статично в seed.
 */
import type {
  Notification,
  NotificationChannelGroup,
  NotificationFilter,
  NotificationSettings,
  NotificationsFeedResponse,
  NotificationTimeGroup,
  PushPermissionState,
} from '@porukam/core';
import { MockError } from './contractsDb';
import { applyDemoEn } from './demoEn';
import { getProfileSettings } from './profilesDb';

/** Тип → группа дублирования/фильтра (§3, §6). `archive_ready` — завершение сделки, тоже «Сделки». */
const TYPE_GROUP: Record<Notification['type'], NotificationChannelGroup> = {
  negotiation: 'deals',
  message: 'chats',
  signature: 'deals',
  signed: 'deals',
  stage_submitted: 'deals',
  accepted: 'deals',
  invite_accepted: 'deals',
  group: 'deals',
  archive_ready: 'deals',
  payment: 'payments',
  deadline: 'deadlines',
  dispute: 'disputes',
};

/** ADR-159: `template_code` — код шаблона строки уведомления. У сида он
 * проставлен всем пунктам (реальный бэк отдаёт его всегда), чтобы фронтовые
 * проверки «повод такой-то» работали в мок-контуре так же, как на API. */
interface SeedNotification extends Omit<Notification, 'group'> {
  /** ISO — на чтении пересчитывается в today/yesterday/earlier относительно Date.now(). */
  created_at: string;
}

function seedNotifications(): SeedNotification[] {
  return [
    // (a) непрочитанные — deadline (due) + action, signature + action, negotiation без строгого срока.
    {
      id: 'ntf-deadline-1',
      template_code: 'milestone_acceptance_reminder',
      type: 'deadline',
      title: 'Срок приёмки этапа истекает через 2 часа',
      action: { label: 'Принять этап', href: '/contracts/c-14001/milestones/ms-2/accept' },
      contract: { id: 'c-14001', number: 'A14001', title: 'Ремонт кухни, 12 м²' },
      counterparty: { name: 'Мастер Ремонт', profile_id: 'pf-masterremont' },
      severity: 'due',
      created_at: '2026-08-08T09:10:00Z',
      read: false,
    },
    {
      id: 'ntf-signature-1',
      template_code: 'signature_requested',
      type: 'signature',
      title: 'Договор ждёт вашей подписи',
      action: { label: 'Подписать договор', href: '/contracts/c-14002/sign' },
      contract: { id: 'c-14002', number: 'B14002', title: 'Укладка ламината, 42 м²' },
      counterparty: { name: 'Николай Гром', profile_id: 'pf-grom' },
      severity: 'due',
      created_at: '2026-08-08T07:40:00Z',
      read: false,
    },
    {
      id: 'ntf-negotiation-1',
      template_code: 'negotiation.revised.proposed',
      type: 'negotiation',
      title: 'Новое предложение по условиям договора',
      action: { label: 'Открыть протокол разногласий', href: '/contracts/c-14003/review' },
      contract: { id: 'c-14003', number: 'C14003', title: 'Электромонтаж в новостройке' },
      counterparty: { name: 'Анна Свет', profile_id: 'pf-annasvet' },
      severity: 'normal',
      created_at: '2026-08-07T15:05:00Z',
      read: false,
    },
    // (c) симметрия (§4 ⭐): один и тот же факт («этап сдан») — нейтральный title ОДИНАКОВЫЙ,
    // action отрезолвлен под роль зрителя: исполнителю — без действия, заказчику — «Принять этап».
    {
      id: 'ntf-stage-submitted-performer',
      template_code: 'milestone_submitted_for_acceptance',
      type: 'stage_submitted',
      title: 'Этап сдан на приёмку',
      contract: { id: 'c-14004', number: 'D14004', title: 'Сборка мебели, гостиная' },
      counterparty: { name: 'Дмитрий Косяк', profile_id: 'pf-kosyak' },
      severity: 'normal',
      created_at: '2026-08-08T08:00:00Z',
      read: false,
    },
    {
      id: 'ntf-stage-submitted-customer',
      template_code: 'milestone_submitted_for_acceptance',
      type: 'stage_submitted',
      title: 'Этап сдан на приёмку',
      action: { label: 'Принять этап', href: '/contracts/c-14005/milestones/ms-1/accept' },
      contract: { id: 'c-14005', number: 'E14005', title: 'Сборка мебели, спальня' },
      counterparty: { name: 'Игорь Волков', profile_id: 'pf-volkov' },
      severity: 'due',
      created_at: '2026-08-08T08:05:00Z',
      read: false,
    },
    // (b) прочитанные — история (журнал событий, §37a).
    {
      id: 'ntf-accepted-1',
      template_code: 'milestone.accepted',
      type: 'accepted',
      title: 'Этап принят',
      contract: { id: 'c-14004', number: 'D14004', title: 'Сборка мебели, гостиная' },
      counterparty: { name: 'Дмитрий Косяк', profile_id: 'pf-kosyak' },
      severity: 'good',
      created_at: '2026-08-05T11:20:00Z',
      read: true,
    },
    {
      id: 'ntf-accepted-auto-1',
      template_code: 'milestone.auto_accepted',
      type: 'accepted',
      title: 'Этап принят автоматически по истечении срока приёмки',
      contract: { id: 'c-14006', number: 'F14006', title: 'Электрика, частный дом' },
      counterparty: { name: 'Мастер Ремонт', profile_id: 'pf-masterremont' },
      severity: 'good',
      created_at: '2026-08-04T20:00:00Z',
      read: true,
    },
    {
      id: 'ntf-payment-1',
      template_code: 'milestone.paid',
      type: 'payment',
      title: 'Оплата этапа получена',
      action: { label: 'Открыть платёж', href: '/contracts/c-14002/payments/pay-1' },
      contract: { id: 'c-14002', number: 'B14002', title: 'Укладка ламината, 42 м²' },
      counterparty: { name: 'Николай Гром', profile_id: 'pf-grom' },
      amount: { amount: '54000', currency: 'RUB' },
      severity: 'good',
      created_at: '2026-08-03T09:00:00Z',
      read: true,
    },
    {
      id: 'ntf-dispute-1',
      template_code: 'dispute.opened',
      type: 'dispute',
      title: 'Открыт спор по этапу',
      action: { label: 'Открыть спор', href: '/contracts/c-14003/review' },
      contract: { id: 'c-14003', number: 'C14003', title: 'Электромонтаж в новостройке' },
      counterparty: { name: 'Анна Свет', profile_id: 'pf-annasvet' },
      severity: 'normal',
      created_at: '2026-08-02T13:30:00Z',
      read: true,
    },
    {
      id: 'ntf-archive-ready-1',
      template_code: 'archive.ready',
      type: 'archive_ready',
      title: 'Архив сделки собран и готов к выгрузке',
      action: { label: 'Открыть архив', href: '/contracts/c-14006/archive' },
      contract: { id: 'c-14006', number: 'F14006', title: 'Электрика, частный дом' },
      counterparty: { name: 'Мастер Ремонт', profile_id: 'pf-masterremont' },
      severity: 'normal',
      created_at: '2026-08-01T10:00:00Z',
      read: true,
    },
    {
      id: 'ntf-invite-accepted-1',
      template_code: 'negotiation.sent.counterparty',
      type: 'invite_accepted',
      title: 'Приглашение принято — контрагент присоединился к сделке',
      // ADR-170: якорь раздела — пункт ведёт в «Переговоры и подписи», а не
      // «куда-то в договор». Зеркало карты `notifications.selectors`.
      action: { label: 'Открыть договор', href: '/contracts/c-14001#negoSign' },
      contract: { id: 'c-14001', number: 'A14001', title: 'Ремонт кухни, 12 м²' },
      counterparty: { name: 'Мастер Ремонт', profile_id: 'pf-masterremont' },
      severity: 'good',
      created_at: '2026-07-30T18:15:00Z',
      read: true,
    },
    {
      id: 'ntf-signed-1',
      template_code: 'contract.signed',
      type: 'signed',
      title: 'Договор подписан обеими сторонами',
      action: { label: 'Открыть договор', href: '/contracts/c-14002#negoSign' },
      contract: { id: 'c-14002', number: 'B14002', title: 'Укладка ламината, 42 м²' },
      counterparty: { name: 'Николай Гром', profile_id: 'pf-grom' },
      severity: 'good',
      created_at: '2026-07-28T12:00:00Z',
      read: true,
    },
    ...seedEarlierTail(),
  ];
}

/**
 * Хвост «Ранее» — чтобы мок показывал пагинацию (решение владельца 05.09:
 * 15 пунктов + «Показать ещё»): без него в ленте было 12 записей и кнопка
 * не появлялась бы никогда. Все прочитанные и старше остальных — счётчики
 * вкладок и первая страница от хвоста не меняются.
 */
function seedEarlierTail(): SeedNotification[] {
  return Array.from({ length: 10 }, (_, i) => ({
    id: `ntf-earlier-${i + 1}`,
    type: 'accepted' as const,
    title: `Этап ${i + 1} принят заказчиком`,
    action: { label: '', href: '/contracts/c-14003' },
    contract: { id: 'c-14003', number: 'C14003', title: 'Сборка мебели, 3 комплекта' },
    counterparty: { name: 'Мастер Ремонт', profile_id: 'pf-masterremont' },
    severity: 'good' as const,
    created_at: new Date(Date.UTC(2026, 6, 27 - i, 9, 0, 0)).toISOString(),
    read: true,
  }));
}

function seedSettings(): NotificationSettings {
  return {
    in_app: true,
    // (e) push_permission: 'default' — мягкий запрос ещё не показывался.
    push: false,
    push_permission: 'default',
    // (f) email выкл по умолчанию — адрес подставлен из аккаунта (мок).
    email: false,
    email_address: 'go••••n@example.com',
    groups: { deals: true, chats: true, payments: true, deadlines: true, disputes: true },
  };
}

/** Сид + английский демо-набор витрины (`demoEn.ts`) — без флага no-op. */
function seedAllNotifications(): SeedNotification[] {
  return applyDemoEn(seedNotifications());
}

let notifications: SeedNotification[] = seedAllNotifications();
let settings: NotificationSettings = applyDemoEn(seedSettings());

export function resetNotifications(): void {
  notifications = seedAllNotifications();
  settings = applyDemoEn(seedSettings());
}

function computeTimeGroup(iso: string, nowMs: number): NotificationTimeGroup {
  const created = new Date(iso);
  const now = new Date(nowMs);
  const dayMs = 86_400_000;
  const createdDay = Math.floor(created.getTime() / dayMs);
  const nowDay = Math.floor(now.getTime() / dayMs);
  const diff = nowDay - createdDay;
  if (diff <= 0) return 'today';
  if (diff === 1) return 'yesterday';
  return 'earlier';
}

function resolve(n: SeedNotification, nowMs: number): Notification {
  const item: Notification = { ...n, group: computeTimeGroup(n.created_at, nowMs) };
  // ADR-173: фото контрагента подставляется на ЧТЕНИИ ленты (как на бэке —
  // ссылка версионируется, в снимке события она бы протухла). В сиде фото
  // нет — null, пока его не загрузят через `/profiles/{id}/avatar`.
  if (item.counterparty) {
    item.counterparty = {
      ...item.counterparty,
      avatar_url: getProfileSettings(item.counterparty.profile_id)?.avatar_url ?? null,
    };
  }
  return item;
}

function groupCounts(list: SeedNotification[]): Record<NotificationChannelGroup, number> {
  const counts: Record<NotificationChannelGroup, number> = { deals: 0, chats: 0, payments: 0, deadlines: 0, disputes: 0 };
  for (const n of list) {
    if (n.read) continue;
    counts[TYPE_GROUP[n.type]] += 1;
  }
  return counts;
}

/** Размер страницы ленты по умолчанию — зеркало бэкенда (FEED_PAGE_SIZE). */
export const FEED_PAGE_SIZE = 15;
export const FEED_PAGE_SIZE_MAX = 50;

export interface FeedPageQuery {
  limit?: number;
  cursor?: string | null;
}

/**
 * Курсор мока — тот же непрозрачный контракт, что у бэкенда: base64 от
 * «created_at|id». Разбирать его фронту нельзя, поэтому и в моке он
 * непрозрачный: подстановка «просто индекса» скрыла бы ошибки клиента,
 * который решил бы курсор вычислять сам.
 */
function encodeCursor(n: SeedNotification): string {
  return btoa(`${n.created_at}|${n.id}`).replace(/=+$/, '');
}

function decodeCursor(cursor: string): string {
  let raw: string;
  try {
    raw = atob(cursor + '='.repeat((4 - (cursor.length % 4)) % 4));
  } catch {
    throw new MockError(400, 'validation_error', 'Курсор не разбирается.');
  }
  const id = raw.split('|')[1];
  if (!id) throw new MockError(400, 'validation_error', 'Курсор не разбирается.');
  return id;
}

/** GET /v1/notifications?filter=&limit=&cursor= (§7) — ОДНА страница ленты. */
export function listNotifications(
  filter: NotificationFilter,
  nowMs = Date.now(),
  page: FeedPageQuery = {},
): NotificationsFeedResponse {
  let list = notifications;
  if (filter === 'unread') list = list.filter((n) => !n.read);
  else if (filter !== 'all') list = list.filter((n) => TYPE_GROUP[n.type] === filter);

  const ordered = [...list].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

  const limit = page.limit ?? FEED_PAGE_SIZE;
  if (!Number.isInteger(limit) || limit < 1 || limit > FEED_PAGE_SIZE_MAX) {
    throw new MockError(400, 'validation_error', `limit — от 1 до ${FEED_PAGE_SIZE_MAX}.`);
  }
  let start = 0;
  if (page.cursor) {
    const afterId = decodeCursor(page.cursor);
    const at = ordered.findIndex((n) => n.id === afterId);
    // Пункт курсора мог быть прочитан/отфильтрован — в мок-ленте это
    // «страниц дальше нет», а не ошибка (бэк на keyset просто отдаст хвост).
    start = at < 0 ? ordered.length : at + 1;
  }
  const slice = ordered.slice(start, start + limit);
  const last = slice[slice.length - 1];
  const hasMore = start + limit < ordered.length;

  return {
    items: slice.map((n) => resolve(n, nowMs)),
    // Счётчики вкладок — по ВСЕЙ ленте, не по странице и не по фильтру.
    unread_count: notifications.filter((n) => !n.read).length,
    groups: groupCounts(notifications),
    next_cursor: hasMore && last ? encodeCursor(last) : null,
    total: ordered.length,
  };
}

export function markRead(id: string, page: FeedPageQuery = {}): NotificationsFeedResponse {
  const n = notifications.find((x) => x.id === id);
  if (!n) throw new MockError(404, 'not_found', 'Уведомление не найдено.');
  n.read = true;
  return listNotifications('all', Date.now(), page);
}

export function markAllRead(page: FeedPageQuery = {}): NotificationsFeedResponse {
  notifications = notifications.map((n) => ({ ...n, read: true }));
  return listNotifications('all', Date.now(), page);
}

export function getNotificationSettings(): NotificationSettings {
  return settings;
}

/** PUT /v1/notification-settings — полная замена (кроме неизменяемого `in_app`). */
export function putNotificationSettings(patch: Partial<Omit<NotificationSettings, 'in_app'>>): NotificationSettings {
  // Denied на уровне устройства/браузера — включить push через приложение нельзя (§5), это
  // проверяет и API, не только UI (тумблер неактивен, но защищаемся и на мок-бэке).
  if (patch.push === true && settings.push_permission === 'denied') {
    throw new MockError(422, 'push_permission_denied', 'Уведомления выключены в настройках устройства.');
  }
  settings = {
    ...settings,
    ...patch,
    in_app: true,
    groups: { ...settings.groups, ...patch.groups },
  };
  return settings;
}

// [Ф-решение] e2e/демо-хуки: состояния push-разрешения недостижимы через реальный системный
// диалог в браузере под Playwright/CI — переключаем мок напрямую, как `debugSetVerificationLevel`
// (DEV-02). В проде отсутствует (`mocks/browser.ts`).
export function debugSetPushPermission(state: PushPermissionState): void {
  settings = { ...settings, push_permission: state, push: state === 'granted' ? settings.push : false };
}
/** У OTP-пользователя адреса нет — рычаг пустого email_address (qa-backlog 2026-08-20 §2). */
export function debugSetEmailAddress(value: string): void {
  settings = { ...settings, email_address: value };
}
export function debugClearAllNotifications(): void {
  notifications = [];
}
