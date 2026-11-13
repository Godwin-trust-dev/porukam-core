/**
 * Платформенный запрос push-разрешения (DEV-14 §5) + реальная Web Push
 * подписка (ADR-110). В вебе — `Notification.requestPermission()` и
 * `PushManager.subscribe()` с VAPID-ключом из `GET /v1/push/config`;
 * в приложении эквивалент — нативный запрос. Копирайт в UI ОДИН и тот же
 * («разрешите приложению отправлять уведомления»), это только платформенный вызов снизу.
 *
 * Вызывать ТОЛЬКО по явному действию пользователя (§5 «мягкий момент») — никогда на загрузке.
 *
 * Источник правды «спросить ли на ЭТОМ устройстве» — сам браузер
 * (`getDevicePushState`), а НЕ серверный флаг: `NotificationSettings.push`
 * по умолчанию `true`, а `push_permission` — одно значение на пользователя, не
 * на устройство (разбор прода 10.09: у пяти из семи активных пользователей
 * `push=true`, `push_permission='default'` и НОЛЬ подписок — им ни разу не
 * предложили разрешение, потому что тумблер уже выглядел включённым).
 *
 * Неудача подписки больше не проглатывается: функции возвращают
 * `PushSubscribeResult` с машинной причиной и обрезанным текстом исключения —
 * иначе «разрешение есть, подписок ноль» неотличимо от «человек не разрешал».
 */
import type { PushPermissionState } from '@porukam/core';
import { api } from '../../shared/api';
import { getNativePushState } from './nativePushToken';

/** Разрешение НА ЭТОМ устройстве; `unsupported` — спрашивать нечего и некого. */
export type DevicePushPermission = PushPermissionState | 'unsupported';

export interface DevicePushState {
  permission: DevicePushPermission;
  /** В этом браузере есть живая подписка `PushManager` (не «сервер думает, что есть»). */
  subscribed: boolean;
  /**
   * Уведомления приходят через приложение Porukam, а не через браузер (ADR-176):
   * обёртка передала токен нативного провайдера. В этом режиме Web Push не нужен
   * и не запрашивается — иначе на одно событие телефон получил бы два уведомления.
   */
  native: boolean;
}

/** Почему подписка не состоялась — машинный код для подсказки в настройках. */
export type PushSubscribeReason =
  | 'no_sw'
  | 'no_push_manager'
  | 'no_key'
  | 'subscribe_failed'
  | 'register_failed'
  /** Разрешения нет — звать `subscribe` бессмысленно (системный запрос отсюда показывать нельзя). */
  | 'no_permission';

export interface PushSubscribeResult {
  ok: boolean;
  reason?: PushSubscribeReason;
  /** `String(err)` из исключения, обрезанный: подсказка человеку, а не стек. */
  message?: string;
}

/** Диагностика показывается ЧЕЛОВЕКУ — длинный текст исключения обрезаем. */
const MESSAGE_LIMIT = 200;

function failure(reason: PushSubscribeReason, err?: unknown): PushSubscribeResult {
  if (err === undefined) return { ok: false, reason };
  return { ok: false, reason, message: String(err).slice(0, MESSAGE_LIMIT) };
}

export function getBrowserPushPermission(): PushPermissionState {
  if (typeof window === 'undefined' || !('Notification' in window)) return 'default';
  const perm = window.Notification.permission;
  return perm === 'granted' || perm === 'denied' ? perm : 'default';
}

/**
 * Устройство вообще умеет Web Push. `Notification` отсутствует во вкладке
 * iOS-Safari (там push живёт только у приложения с экрана «Домой»), `PushManager` —
 * в сборках без push-сервиса; и то и другое означает «спрашивать нечего».
 */
export function isBrowserPushSupported(): boolean {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return false;
  return 'Notification' in window && 'serviceWorker' in navigator && 'PushManager' in window;
}

export async function requestBrowserPushPermission(): Promise<PushPermissionState> {
  if (typeof window === 'undefined' || !('Notification' in window)) return 'default';
  try {
    const result = await window.Notification.requestPermission();
    return result === 'granted' || result === 'denied' ? result : 'default';
  } catch {
    return getBrowserPushPermission();
  }
}

/**
 * Состояние ЭТОГО устройства — единственный честный ответ на вопросы «спросить ли
 * разрешение здесь» и «доходят ли сюда уведомления». Серверные `push` /
 * `push_permission` описывают аккаунт целиком: разрешив уведомления на одном
 * устройстве, человек на втором видел включённый тумблер и не получал ничего.
 */
export async function getDevicePushState(): Promise<DevicePushState> {
  // Нативный канал старше браузерного: если обёртка передала токен, вопрос
  // «дойдёт ли уведомление сюда» решён приложением, и разрешение браузера на
  // этот ответ уже не влияет (ADR-176).
  const native = getNativePushState().active;
  if (!isBrowserPushSupported()) return { permission: 'unsupported', subscribed: false, native };
  const permission = getBrowserPushPermission();
  if (native) return { permission, subscribed: false, native: true };
  const registration = await swRegistration();
  if (!registration || !('pushManager' in registration)) return { permission, subscribed: false, native };
  try {
    const subscription = await registration.pushManager.getSubscription();
    return { permission, subscribed: subscription != null, native };
  } catch {
    // `getSubscription` падает в приватных режимах — это и значит «подписки нет».
    return { permission, subscribed: false, native };
  }
}

/** `applicationServerKey` для `PushManager.subscribe()` — base64url → байты. */
export function urlBase64ToUint8Array(base64url: string): Uint8Array {
  const padding = '='.repeat((4 - (base64url.length % 4)) % 4);
  const base64 = (base64url + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  return Uint8Array.from(raw, (ch) => ch.charCodeAt(0));
}

/**
 * Сколько ждать активации service worker'а. Десять секунд — это «дольше, чем
 * успевает установиться SW на медленном телефоне» и «заметно меньше, чем
 * человек проведёт на первом экране». Ждать без предела нельзя: в мок-контуре
 * SW не регистрируется вовсе (см. `swRegistration` ниже), и `ready` там не
 * разрешится никогда.
 */
export const SW_READY_TIMEOUT_MS = 10_000;

/**
 * Дождаться, пока service worker будет ГОТОВ (активен), но не дольше таймаута.
 *
 * Зачем это push'у. Подписка живёт у активной регистрации: `getRegistration()`
 * сразу после загрузки страницы отдаёт либо `undefined`, либо регистрацию в
 * состоянии `installing`, у которой `pushManager.subscribe` падает. Сверка при
 * входе стартовала именно в этот момент — и подписка не создавалась, пока
 * человек не выходил и не входил заново (владелец 10.09: «вышла из сессии в
 * браузере, и потом заработали»).
 *
 * `true` — SW готов; `false` — его нет или он не успел. Ответ информационный:
 * попытку всё равно делают, чтобы у неудачи была причина (`no_sw`), которую
 * видно в настройках (ADR-175 §4).
 */
export async function waitForServiceWorkerReady(timeoutMs: number = SW_READY_TIMEOUT_MS): Promise<boolean> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      navigator.serviceWorker.ready.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } catch {
    return false;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function swRegistration(): Promise<ServiceWorkerRegistration | null> {
  // `getRegistration`, не `ready`: в мок-контуре SW не регистрируется
  // (swRegistration.ts гейтится VITE_API_MODE) и `ready` повис бы навсегда.
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return null;
  try {
    return (await navigator.serviceWorker.getRegistration()) ?? null;
  } catch {
    return null;
  }
}

/** Ключ подписки с бэка. Пустой ключ = Web Push на инсталляции не настроен. */
async function fetchVapidKey(): Promise<{ key: string } | PushSubscribeResult> {
  try {
    const { vapid_public_key } = await api.request<{ vapid_public_key: string }>('/push/config');
    if (!vapid_public_key) return failure('no_key');
    return { key: vapid_public_key };
  } catch (err) {
    return failure('no_key', err);
  }
}

function isFailure(x: { key: string } | PushSubscribeResult): x is PushSubscribeResult {
  return 'ok' in x;
}

/** Регистрация endpoint на бэке — последний шаг, после которого подписка «есть». */
async function registerSubscription(subscription: PushSubscription): Promise<PushSubscribeResult> {
  const json = subscription.toJSON();
  if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) return failure('subscribe_failed');
  try {
    await api.request('/push-subscriptions', {
      method: 'POST',
      body: { endpoint: json.endpoint, keys: { p256dh: json.keys.p256dh, auth: json.keys.auth } },
    });
  } catch (err) {
    return failure('register_failed', err);
  }
  return { ok: true };
}

/**
 * Web Push подписка (ADR-110): ключ с бэка → `pushManager.subscribe` →
 * регистрация endpoint на бэке. Вызывается ПОСЛЕ выданного разрешения.
 * `{ok: true}` — подписка доехала до бэка; иначе `reason` + текст исключения:
 * без них «разрешение granted, подписок ноль» (прод 10.09) не диагностируется.
 */
export async function subscribeBrowserPush(): Promise<PushSubscribeResult> {
  const registration = await swRegistration();
  if (!registration) return failure('no_sw');
  if (!('pushManager' in registration)) return failure('no_push_manager');
  const key = await fetchVapidKey();
  if (isFailure(key)) return key;
  let subscription: PushSubscription;
  try {
    subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(key.key).buffer as ArrayBuffer,
    });
  } catch (err) {
    return failure('subscribe_failed', err);
  }
  return registerSubscription(subscription);
}

/**
 * Сверка подписки при входе в приложение (отсмотр 2026-08-27: у трёх пользователей
 * тумблер включён, разрешение выдано, а подписок в БД — ноль, бэк пишет
 * `no_subscription`). `subscribeBrowserPush` вызывается только в момент включения
 * тумблера, и если тогда SW ещё не был зарегистрирован или `/push/config` отдал
 * пустой ключ (прод без VAPID на тот момент), подписка не создавалась НИКОГДА.
 * Здесь — идемпотентная починка: вызывать, когда `settings.push === true` и
 * разрешение уже `granted` (системный запрос не показывается — §5 не нарушен).
 *  - подписки нет → подписать под текущим ключом;
 *  - подписка есть, но под другим ключом (VAPID меняли) → пересоздать;
 *  - подписка есть под тем же ключом → просто перерегистрировать endpoint на бэке
 *    (update_or_create по endpoint — бэк мог потерять строку по 404/410 или после
 *    переустановки SW на другом устройстве).
 * Результат — с причиной: он же показывается в настройках как «подписка не удалась».
 */
export async function ensureBrowserPushSubscription(): Promise<PushSubscribeResult> {
  if (getBrowserPushPermission() !== 'granted') return failure('no_permission');
  const registration = await swRegistration();
  if (!registration) return failure('no_sw');
  if (!('pushManager' in registration)) return failure('no_push_manager');
  const key = await fetchVapidKey();
  if (isFailure(key)) return key;
  const wantedKey = urlBase64ToUint8Array(key.key);
  let subscription: PushSubscription | null;
  try {
    subscription = await registration.pushManager.getSubscription();
    if (subscription && !sameServerKey(subscription, wantedKey)) {
      await subscription.unsubscribe();
      subscription = null;
    }
    if (!subscription) {
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: wantedKey.buffer as ArrayBuffer,
      });
    }
  } catch (err) {
    return failure('subscribe_failed', err);
  }
  return registerSubscription(subscription);
}

/**
 * Ключ существующей подписки совпадает с ключом сервера (без ключа в options — считаем «свой»).
 * Экспортируется ради панели диагностики (`pushDebug.ts`): там тот же вопрос задают
 * человеку в лоб — «подписка создана под НАШИМ ключом?», и вторая реализация того же
 * побайтного сравнения разошлась бы с этой ровно в тот момент, когда ответ важен.
 */
export function sameServerKey(subscription: PushSubscription, wanted: Uint8Array): boolean {
  const current = subscription.options?.applicationServerKey;
  if (!current) return true;
  const bytes = new Uint8Array(current);
  if (bytes.length !== wanted.length) return false;
  for (let i = 0; i < bytes.length; i += 1) if (bytes[i] !== wanted[i]) return false;
  return true;
}

export async function unsubscribeBrowserPush(): Promise<void> {
  const registration = await swRegistration();
  if (!registration || !('pushManager' in registration)) return;
  try {
    const subscription = await registration.pushManager.getSubscription();
    if (!subscription) return;
    const endpoint = subscription.endpoint;
    await subscription.unsubscribe();
    await api.request('/push-subscriptions/unsubscribe', { method: 'POST', body: { endpoint } });
  } catch {
    // Best effort: мёртвый endpoint бэк вычистит сам по 404/410 (ADR-110).
  }
}
