/**
 * Нативный канал уведомлений: приём токена провайдера из стартового URL обёртки
 * и его регистрация на бэке (ADR-176).
 *
 * Почему через URL. Обёртка — это TWA: страница живёт в обычном браузере, а не в
 * WebView, поэтому JS-моста между нативным кодом и вебом не существует вовсе.
 * Единственный канал, который у обёртки есть, — адрес, с которого она открывает
 * приложение. Нативный слой получает токен у RuStore Universal Push SDK
 * (RuStore / FCM / HMS — что нашлось на устройстве) и подставляет его в старт:
 *
 *   https://porukam.app/?src=twa&push_provider=<rustore|fcm|hms>&push_token=<token>&app_id=<applicationId>
 *
 * Что здесь важно сделать в первую же миллисекунду загрузки:
 *
 * 1. **Вырезать параметры из адреса.** Токен устройства — секрет: оставшись в
 *    адресной строке, он уедет в `Referer` на первую же внешнюю ссылку, в
 *    историю браузера и в любой аналитический счётчик, который читает
 *    `location.search`. Поэтому `history.replaceState` вызывается ДО первого
 *    рендера и ДО отправки события установки (ADR-171).
 * 2. **Сохранить в `localStorage`, а не в `sessionStorage`.** Обёртка передаёт
 *    токен на старте, но человек закроет и откроет приложение снова — и
 *    следующий запуск может прийти уже без параметров (SDK отдаёт токен
 *    асинхронно и не всегда успевает к моменту открытия). Токен принадлежит
 *    УСТРОЙСТВУ и обязан пережить и вкладку, и выход из аккаунта.
 *
 * Регистрация на бэке — отдельный шаг (`useNativePushRegister`): она требует
 * входа, а токен приезжает раньше него.
 */
import { ApiError } from '@porukam/core';
import { api } from '../../shared/api';

/** Ключ хранилища. Его же знает агент обёртки — менять только вместе с ней. */
export const NATIVE_PUSH_STORAGE_KEY = 'porukam.nativePush';

/** Имена параметров стартового URL — контракт с нативным слоем обёртки. */
export const NATIVE_PUSH_PARAMS = ['push_provider', 'push_token', 'app_id'] as const;

export const NATIVE_PUSH_PROVIDERS = ['rustore', 'fcm', 'hms'] as const;
export type NativePushProvider = (typeof NATIVE_PUSH_PROVIDERS)[number];

/**
 * Предел длины токена. Реальные токены провайдеров — сотни символов; 4096 —
 * запас, за которым в параметре лежит уже не токен, а чужая подстановка.
 */
export const NATIVE_PUSH_TOKEN_MAX = 4096;

/** Раз в сутки токен подтверждается на бэке заново — это его `last_seen`. */
export const NATIVE_PUSH_REFRESH_MS = 24 * 60 * 60 * 1000;

/** Почему регистрация не состоялась — машинный код, как у `PushSubscribeResult`. */
export type NativePushRegisterReason = 'no_token' | 'unauthorized' | 'register_failed';

export interface NativePushRegisterResult {
  ok: boolean;
  reason?: NativePushRegisterReason;
  /** `String(err)` из исключения, обрезанный: подсказка человеку, а не стек. */
  message?: string;
}

export interface NativePushRecord {
  provider: NativePushProvider;
  token: string;
  /** `applicationId` сборки обёртки: у Play и RuStore он разный (ADR-176). */
  appId: string;
  /** ISO — когда обёртка передала этот токен браузеру. */
  receivedAt: string;
  /** ISO последней УСПЕШНОЙ регистрации на бэке (он же отметка `last_seen`). */
  registeredAt?: string;
  /** Чей аккаунт закреплён за токеном на бэке — по нему ловится смена пользователя. */
  registeredFor?: string;
  /** Исход последней попытки — его показывает панель `?debug=push`. */
  lastResult?: NativePushRegisterResult;
  /**
   * Web Push-подписка этого браузера уже снята. Снимается ОДИН раз при первой
   * успешной регистрации нативного токена: иначе один телефон получил бы два
   * уведомления на одно событие — от приложения и от браузера (ADR-176).
   */
  webPushCleared?: boolean;
}

export interface NativePushState {
  /** Есть валидный сохранённый токен — уведомления идут через приложение. */
  active: boolean;
  record: NativePushRecord | null;
}

const MESSAGE_LIMIT = 200;

function isProvider(value: unknown): value is NativePushProvider {
  return typeof value === 'string' && (NATIVE_PUSH_PROVIDERS as readonly string[]).includes(value);
}

/** Токен непустой и не длиннее предела — единственное, что о нём можно проверить здесь. */
function isToken(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= NATIVE_PUSH_TOKEN_MAX;
}

function readStorage(): NativePushRecord | null {
  if (typeof window === 'undefined') return null;
  let raw: string | null;
  try {
    raw = window.localStorage.getItem(NATIVE_PUSH_STORAGE_KEY);
  } catch {
    // Приватный режим / запрет хранилища — считаем, что нативного канала нет.
    return null;
  }
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    const rec = parsed as Partial<NativePushRecord>;
    if (!isProvider(rec.provider) || !isToken(rec.token)) return null;
    return {
      provider: rec.provider,
      token: rec.token,
      appId: typeof rec.appId === 'string' ? rec.appId : '',
      receivedAt: typeof rec.receivedAt === 'string' ? rec.receivedAt : '',
      registeredAt: typeof rec.registeredAt === 'string' ? rec.registeredAt : undefined,
      registeredFor: typeof rec.registeredFor === 'string' ? rec.registeredFor : undefined,
      lastResult:
        rec.lastResult && typeof rec.lastResult === 'object' ? (rec.lastResult as NativePushRegisterResult) : undefined,
      webPushCleared: rec.webPushCleared === true,
    };
  } catch {
    // Битая запись равносильна её отсутствию — переписать её сможет обёртка.
    return null;
  }
}

function writeStorage(record: NativePushRecord): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(NATIVE_PUSH_STORAGE_KEY, JSON.stringify(record));
  } catch {
    // Не сохранилось — канал просто не включится; ломать загрузку нельзя.
  }
}

/** Сохранённый токен устройства (без обращения к URL). */
export function getNativePushToken(): NativePushRecord | null {
  return readStorage();
}

/**
 * Работает ли на этом устройстве нативный канал. Единственный признак — валидный
 * сохранённый токен: он приходит только от обёртки и только один раз за установку.
 */
export function getNativePushState(): NativePushState {
  const record = readStorage();
  return { active: record !== null, record };
}

/** Обновить сохранённую запись (регистрация, смена владельца, снятие Web Push). */
export function updateNativePushRecord(patch: Partial<NativePushRecord>): NativePushRecord | null {
  const current = readStorage();
  if (!current) return null;
  const next: NativePushRecord = { ...current, ...patch };
  writeStorage(next);
  return next;
}

/**
 * Разбор стартового URL: вырезать параметры из адреса, валидное — сохранить.
 *
 * Параметры вырезаются ВСЕГДА, как только хоть один из них встретился, — даже
 * если значение не прошло проверку: мусор в адресной строке всё равно уедет в
 * реферер, а объяснить его человеку нечем. Возвращается сохранённая запись или
 * `null`, если в адресе ничего пригодного не было.
 */
export function captureNativePushToken(now: Date = new Date()): NativePushRecord | null {
  if (typeof window === 'undefined') return null;
  let url: URL;
  try {
    url = new URL(window.location.href);
  } catch {
    return null;
  }
  const present = NATIVE_PUSH_PARAMS.some((name) => url.searchParams.has(name));
  if (!present) return null;

  const provider = url.searchParams.get('push_provider');
  const token = url.searchParams.get('push_token');
  const appId = url.searchParams.get('app_id') ?? '';

  for (const name of NATIVE_PUSH_PARAMS) url.searchParams.delete(name);
  try {
    window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
  } catch {
    // `replaceState` запрещён (песочница) — токен всё равно не сохраняем в адрес повторно.
  }

  if (!isProvider(provider) || !isToken(token)) return null;

  const previous = readStorage();
  // Тот же токен на новом запуске обёртки — сохраняем историю регистрации:
  // иначе приложение перерегистрировало бы устройство при каждом открытии.
  const same = previous !== null && previous.provider === provider && previous.token === token;
  const record: NativePushRecord = same
    ? { ...previous, appId: appId || previous.appId }
    : { provider, token, appId, receivedAt: now.toISOString() };
  writeStorage(record);
  return record;
}

function failure(reason: NativePushRegisterReason, err?: unknown): NativePushRegisterResult {
  if (err === undefined) return { ok: false, reason };
  return { ok: false, reason, message: String(err).slice(0, MESSAGE_LIMIT) };
}

/**
 * Регистрация токена на бэке (`POST /v1/device-tokens`, идемпотентна по токену).
 * `platform: 'android'` — единственная платформа нативного канала: у iOS обёртки
 * нет вовсе, там уведомления остаются веб-каналом (ADR-176 «Не делаем»).
 */
export async function registerNativePushToken(record: NativePushRecord): Promise<NativePushRegisterResult> {
  if (!isProvider(record.provider) || !isToken(record.token)) return failure('no_token');
  try {
    await api.request('/device-tokens', {
      method: 'POST',
      body: { provider: record.provider, token: record.token, app_id: record.appId, platform: 'android' },
    });
  } catch (err) {
    // 401 — человек ещё не вошёл: не ошибка канала, повтор произойдёт после входа.
    if (err instanceof ApiError && err.status === 401) return failure('unauthorized');
    return failure('register_failed', err);
  }
  return { ok: true };
}

/**
 * Снятие токена с аккаунта при выходе (`POST /v1/device-tokens/unregister`).
 * Локальная запись НЕ удаляется: токен принадлежит устройству, а не аккаунту, —
 * следующий вход зарегистрирует его заново, уже на нового владельца.
 */
export async function unregisterNativePushToken(): Promise<void> {
  const record = readStorage();
  if (!record) return;
  try {
    await api.request('/device-tokens/unregister', { method: 'POST', body: { token: record.token } });
  } catch {
    // Best effort: выход из аккаунта не имеет права зависеть от сети.
  }
  updateNativePushRecord({ registeredAt: undefined, registeredFor: undefined });
}

/**
 * Пора ли (пере)регистрировать токен: не регистрировали вовсе, владелец сменился
 * (в приложение вошли другим аккаунтом) или прошли сутки — подтверждение `last_seen`,
 * по которому бэк отличает живое устройство от давно удалённого.
 */
export function needsNativePushRegister(record: NativePushRecord, userId: string | null, now: Date = new Date()): boolean {
  if (!record.registeredAt) return true;
  if ((record.registeredFor ?? null) !== userId) return true;
  const at = Date.parse(record.registeredAt);
  if (Number.isNaN(at)) return true;
  return now.getTime() - at >= NATIVE_PUSH_REFRESH_MS;
}
