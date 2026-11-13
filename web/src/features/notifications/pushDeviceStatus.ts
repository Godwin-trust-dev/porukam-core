/**
 * Статус push НА ЭТОМ устройстве одним словом — то, что человек читает под
 * тумблером (ADR-175). Чистая функция + карты ключей i18n: и подсказка, и тест
 * на неё не зависят ни от React, ни от сети.
 *
 * Почему статусов пять, а не «вкл/выкл»: серверный тумблер отвечает на вопрос
 * «хочу ли я push», а устройство — на вопрос «дойдёт ли он сюда». Разошлись эти
 * два ответа — молчание, и до 10.09 оно выглядело как «уведомления включены».
 */
import type { DevicePushState, PushSubscribeReason, PushSubscribeResult } from './push';

export type PushDeviceStatus =
  /** Состояние устройства ещё не прочитано (первый кадр). */
  | 'loading'
  /** Разрешение на этом устройстве ни разу не запрашивали. */
  | 'not_asked'
  /** Разрешение есть И подписка в этом браузере жива. */
  | 'enabled'
  /** Человек отказал в системном диалоге — из приложения не переспросить. */
  | 'denied'
  /** Устройство не умеет Web Push (вкладка iOS-Safari, сборка без push-сервиса). */
  | 'unsupported'
  /** Разрешение есть, а подписки нет — та самая тихая поломка. */
  | 'failed'
  /** Уведомления идут через приложение Porukam — браузерный канал тут не нужен (ADR-176). */
  | 'native';

export function devicePushStatus(state: DevicePushState | null): PushDeviceStatus {
  if (state === null) return 'loading';
  // Первым: в обёртке с нативным токеном уведомления показывает приложение, и
  // ни отсутствие разрешения у браузера, ни `unsupported` (Huawei без сервисов
  // Google) уже не означают «сюда не дойдёт».
  if (state.native) return 'native';
  if (state.permission === 'unsupported') return 'unsupported';
  if (state.permission === 'denied') return 'denied';
  if (state.permission === 'default') return 'not_asked';
  return state.subscribed ? 'enabled' : 'failed';
}

/** Ключ подсказки статуса; `failed` подставляет причину через `{{reason}}`. */
export const PUSH_DEVICE_STATUS_KEY: Record<PushDeviceStatus, string | null> = {
  loading: null,
  not_asked: 'notifications.pushDeviceNotAsked',
  enabled: 'notifications.pushDeviceEnabled',
  denied: 'notifications.pushDeviceDenied',
  unsupported: 'notifications.pushDeviceUnsupported',
  failed: 'notifications.pushDeviceFailed',
  native: 'notifications.pushDeviceNative',
};

/** Человеческая формулировка машинной причины (`PushSubscribeResult.reason`). */
export const PUSH_DEVICE_REASON_KEY: Record<PushSubscribeReason, string> = {
  no_sw: 'notifications.pushDeviceReasonNoSw',
  no_push_manager: 'notifications.pushDeviceReasonNoPushManager',
  no_key: 'notifications.pushDeviceReasonNoKey',
  subscribe_failed: 'notifications.pushDeviceReasonSubscribeFailed',
  register_failed: 'notifications.pushDeviceReasonRegisterFailed',
  no_permission: 'notifications.pushDeviceReasonNoPermission',
};

/**
 * Причина для показа: та, что вернула последняя попытка подписки. Попытки не
 * было вовсе (перезагрузили страницу, а сверка ещё не отработала) — честнее
 * сказать «устройство отказало в подписке», чем не сказать ничего.
 */
export function failureReasonKey(last: PushSubscribeResult | null): string {
  const reason = last && !last.ok && last.reason ? last.reason : 'subscribe_failed';
  return PUSH_DEVICE_REASON_KEY[reason];
}
