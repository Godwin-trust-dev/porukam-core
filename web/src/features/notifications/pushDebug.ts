/**
 * Снимок состояния Web Push НА ЭТОМ УСТРОЙСТВЕ — сырые факты, без интерпретации.
 *
 * Прод 10.09: телефон владельца (Android; Chrome, Samsung Internet и TWA-обёртка из
 * Play) после «Разрешить» создаёт подписку — nginx пишет `POST /v1/push-subscriptions
 * -> 201`, — а строка состояния под тумблером при этом показывает «разрешение не
 * запрошено», то есть `Notification.permission` читается как `default`. Уведомления не
 * приходят. Двух источников (наш UI + логи бэка) на такую пару не хватает, а devtools
 * на телефоне владельца нет: нужен третий — то, что говорит о себе само устройство.
 *
 * Поэтому здесь НЕТ выводов и нормализации: каждое значение показывается как есть,
 * ошибка каждого вызова — текстом ошибки, а не «нет». Панель только ЧИТАЕТ: ни
 * `subscribe`, ни `unsubscribe`, ни `requestPermission` отсюда не вызываются —
 * диагностика не должна менять то, что диагностирует.
 *
 * Значения намеренно по-английски: это идентификаторы браузерных API и их состояния
 * (`granted`, `activated`, `prompt`), которые владелец пересылает дословно; перевод
 * снимка сделал бы его непригодным для сверки со спецификацией и логами.
 */
import { api } from '../../shared/api';
import { getNativePushState, type NativePushRegisterResult } from './nativePushToken';
import { sameServerKey, urlBase64ToUint8Array } from './push';

export interface PushDebugEntry {
  /** Технический идентификатор факта (`Notification.permission`), не UI-подпись. */
  key: string;
  value: string;
}

const PRESENT = 'yes';
const ABSENT = 'no';
const NO_API = 'no API';
const NO_KEY = 'no server key';
/** Текст исключения читает человек в мессенджере — длинный стек ему не нужен. */
const MESSAGE_LIMIT = 200;

function errorText(err: unknown): string {
  return `error: ${String(err).slice(0, MESSAGE_LIMIT)}`;
}

/** Standalone против вкладки: в TWA и установленном PWA поведение push разное. */
function displayMode(): string {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return NO_API;
  try {
    return window.matchMedia('(display-mode: standalone)').matches ? 'standalone' : 'browser';
  } catch (err) {
    return errorText(err);
  }
}

/**
 * `navigator.permissions` — второй, независимый от `Notification.permission` ответ на
 * тот же вопрос. Их расхождение и есть главная гипотеза по жалобе 10.09.
 */
async function permissionState(name: string, userVisibleOnly = false): Promise<string> {
  if (typeof navigator === 'undefined' || !navigator.permissions) return NO_API;
  try {
    const descriptor = (userVisibleOnly ? { name, userVisibleOnly: true } : { name }) as unknown as PermissionDescriptor;
    const status = await navigator.permissions.query(descriptor);
    return status.state;
  } catch (err) {
    return errorText(err);
  }
}

function workerStates(registration: ServiceWorkerRegistration): string {
  const part = (label: string, worker: ServiceWorker | null): string => `${label}=${worker ? worker.state : 'none'}`;
  return [
    part('active', registration.active),
    part('installing', registration.installing),
    part('waiting', registration.waiting),
  ].join(' ');
}

/**
 * Нативный канал обёртки (ADR-176). Токен НЕ показывается целиком: он — секрет
 * устройства, а снимок владелец пересылает в мессенджер. Восьми символов хватает,
 * чтобы сверить «тот же токен, что зарегистрирован на бэке» — и не хватает, чтобы
 * им воспользоваться.
 */
function nativePushRows(rows: PushDebugEntry[]): void {
  const { record } = getNativePushState();
  rows.push({ key: 'nativePush.provider', value: record ? record.provider : ABSENT });
  rows.push({ key: 'nativePush.tokenPrefix', value: record ? `${record.token.slice(0, 8)}…` : ABSENT });
  rows.push({ key: 'nativePush.registeredAt', value: record?.registeredAt ?? 'never' });
  rows.push({ key: 'nativePush.lastResult', value: formatNativeResult(record?.lastResult) });
}

function formatNativeResult(result: NativePushRegisterResult | undefined): string {
  if (!result) return 'none';
  const parts = [`ok=${String(result.ok)}`];
  if (result.reason) parts.push(`reason=${result.reason}`);
  if (result.message) parts.push(`message=${result.message}`);
  return parts.join(' ');
}

/** Хост endpoint'а, а не сам endpoint: адрес подписки — секрет, отправлять его в чат нельзя. */
function endpointHost(endpoint: string): string {
  try {
    return new URL(endpoint).host;
  } catch (err) {
    return errorText(err);
  }
}

async function pushManagerPermission(
  registration: ServiceWorkerRegistration,
  key: Uint8Array | null,
): Promise<string> {
  try {
    const options: PushSubscriptionOptionsInit = key
      ? { userVisibleOnly: true, applicationServerKey: key.buffer as ArrayBuffer }
      : { userVisibleOnly: true };
    return await registration.pushManager.permissionState(options);
  } catch (err) {
    return errorText(err);
  }
}

/** Ключ сервера — тот же `GET /v1/push/config`, которым подписывается `push.ts`. */
async function serverVapidKey(rows: PushDebugEntry[]): Promise<Uint8Array | null> {
  try {
    const { vapid_public_key: raw } = await api.request<{ vapid_public_key: string }>('/push/config');
    if (!raw) {
      rows.push({ key: 'server.vapidKey', value: '(empty)' });
      return null;
    }
    const key = urlBase64ToUint8Array(raw);
    // Не весь ключ: он публичный, но в снимке важна лишь его опознаваемость.
    rows.push({ key: 'server.vapidKey', value: `${raw.slice(0, 12)}… ${raw.length} chars` });
    rows.push({ key: 'server.vapidKeyBytes', value: String(key.length) });
    return key;
  } catch (err) {
    rows.push({ key: 'server.vapidKey', value: errorText(err) });
    return null;
  }
}

async function collectSubscription(
  rows: PushDebugEntry[],
  registration: ServiceWorkerRegistration,
  serverKey: Uint8Array | null,
): Promise<void> {
  let subscription: PushSubscription | null;
  try {
    subscription = await registration.pushManager.getSubscription();
  } catch (err) {
    rows.push({ key: 'subscription', value: errorText(err) });
    return;
  }
  rows.push({ key: 'subscription', value: subscription ? PRESENT : ABSENT });
  if (!subscription) return;
  rows.push({ key: 'subscription.endpointHost', value: endpointHost(subscription.endpoint) });
  const key = subscription.options?.applicationServerKey;
  rows.push({ key: 'subscription.keyBytes', value: key ? String(new Uint8Array(key).length) : 'none' });
  rows.push({
    key: 'subscription.keyMatchesServer',
    value: serverKey ? String(sameServerKey(subscription, serverKey)) : NO_KEY,
  });
  rows.push({
    key: 'subscription.expirationTime',
    value: subscription.expirationTime == null ? 'null' : String(subscription.expirationTime),
  });
}

/**
 * Полный снимок. Порядок строк — от общего к частному (устройство → разрешение →
 * фоновая служба → ключ → подписка): его читают сверху вниз в переписке.
 */
export async function collectPushDebug(): Promise<PushDebugEntry[]> {
  const rows: PushDebugEntry[] = [];
  rows.push({ key: 'userAgent', value: typeof navigator === 'undefined' ? NO_API : navigator.userAgent });
  rows.push({ key: 'display-mode', value: displayMode() });
  // У TWA из Play здесь `android-app://<package>` — единственный надёжный признак обёртки.
  rows.push({ key: 'document.referrer', value: (typeof document === 'undefined' ? '' : document.referrer) || '(empty)' });
  rows.push({ key: 'location.origin', value: typeof window === 'undefined' ? NO_API : window.location.origin });
  // Нативный канал — ПЕРЕД браузерным: если он работает, всё, что ниже, к
  // доставке уведомлений на этот телефон отношения уже не имеет (ADR-176).
  nativePushRows(rows);

  rows.push({
    key: 'Notification.permission',
    value: typeof window !== 'undefined' && 'Notification' in window ? String(window.Notification.permission) : NO_API,
  });
  rows.push({ key: 'permissions.notifications', value: await permissionState('notifications') });
  rows.push({ key: 'permissions.push', value: await permissionState('push', true) });

  let registration: ServiceWorkerRegistration | null = null;
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
    rows.push({ key: 'serviceWorker', value: NO_API });
  } else {
    try {
      registration = (await navigator.serviceWorker.getRegistration()) ?? null;
    } catch (err) {
      rows.push({ key: 'serviceWorker.getRegistration', value: errorText(err) });
    }
    rows.push({ key: 'serviceWorker.controller', value: navigator.serviceWorker.controller ? PRESENT : ABSENT });
  }
  rows.push({ key: 'serviceWorker.registration', value: registration ? PRESENT : ABSENT });
  if (registration) {
    rows.push({ key: 'serviceWorker.scope', value: registration.scope });
    rows.push({ key: 'serviceWorker.workers', value: workerStates(registration) });
  }

  const serverKey = await serverVapidKey(rows);

  if (!registration || !('pushManager' in registration)) {
    rows.push({ key: 'pushManager', value: NO_API });
    return rows;
  }
  rows.push({
    key: 'pushManager.permissionState(key)',
    value: serverKey ? await pushManagerPermission(registration, serverKey) : NO_KEY,
  });
  rows.push({ key: 'pushManager.permissionState()', value: await pushManagerPermission(registration, null) });
  await collectSubscription(rows, registration, serverKey);
  return rows;
}

/** Снимок одним текстом — ровно то, что уедет в мессенджер. */
export function formatPushDebug(rows: PushDebugEntry[]): string {
  return rows.map((row) => `${row.key}: ${row.value}`).join('\n');
}
