import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  captureNativePushToken,
  getNativePushState,
  getNativePushToken,
  needsNativePushRegister,
  registerNativePushToken,
  unregisterNativePushToken,
  updateNativePushRecord,
  NATIVE_PUSH_STORAGE_KEY,
  NATIVE_PUSH_TOKEN_MAX,
  type NativePushRecord,
} from '../src/features/notifications/nativePushToken';
import { deviceTokens } from '../src/mocks/deviceTokenHandlers';
import { useAuthStore } from '../src/features/auth/authStore';

/**
 * Приём токена нативного пуша из стартового URL обёртки (ADR-176).
 *
 * Обёртка — TWA: JS-моста между нативным кодом и страницей нет, единственный
 * канал передачи — адрес запуска. Отсюда два свойства, за которыми следят эти
 * тесты: параметры обязаны исчезнуть из адреса (токен — секрет устройства, из
 * адресной строки он уедет в реферер и в историю), а сама запись — пережить
 * перезапуск приложения без параметров.
 */

const TOKEN = 'cXbY0ZaW-token-from-provider';

function go(search: string): void {
  window.history.replaceState(null, '', `/notifications${search}`);
}

describe('captureNativePushToken — разбор стартового URL обёртки (ADR-176)', () => {
  beforeEach(() => {
    localStorage.removeItem(NATIVE_PUSH_STORAGE_KEY);
    go('');
  });
  afterEach(() => {
    localStorage.removeItem(NATIVE_PUSH_STORAGE_KEY);
    vi.restoreAllMocks();
  });

  it('валидный URL: токен сохранён, параметры вырезаны, остальной запрос цел', () => {
    go(`?src=twa&push_provider=rustore&push_token=${TOKEN}&app_id=porukam.app&filter=unread`);

    const record = captureNativePushToken(new Date('2026-09-10T10:00:00.000Z'));

    expect(record).toMatchObject({
      provider: 'rustore',
      token: TOKEN,
      appId: 'porukam.app',
      receivedAt: '2026-09-10T10:00:00.000Z',
    });
    // Токен не остался в адресной строке — иначе он уедет в `Referer`.
    expect(window.location.search).toBe('?src=twa&filter=unread');
    expect(getNativePushToken()).toMatchObject({ token: TOKEN });
    expect(getNativePushState().active).toBe(true);
  });

  it.each([
    ['неизвестный провайдер', `?push_provider=apns&push_token=${TOKEN}&app_id=porukam.app`],
    ['пустой токен', '?push_provider=fcm&push_token=&app_id=porukam.app'],
    ['провайдера нет вовсе', `?push_token=${TOKEN}&app_id=porukam.app`],
  ])('невалидный URL (%s): ничего не сохранено, но адрес всё равно очищен', (_name, search) => {
    go(search);

    expect(captureNativePushToken()).toBeNull();
    expect(getNativePushState().active).toBe(false);
    expect(window.location.search).toBe('');
  });

  it('токен длиннее предела игнорируется — в параметре уже не токен', () => {
    go(`?push_provider=fcm&push_token=${'a'.repeat(NATIVE_PUSH_TOKEN_MAX + 1)}`);

    expect(captureNativePushToken()).toBeNull();
    expect(getNativePushState().active).toBe(false);
  });

  it('параметров нет: адрес не трогаем и сохранённый токен не теряем', () => {
    go(`?push_provider=hms&push_token=${TOKEN}&app_id=porukam.app`);
    captureNativePushToken();

    // Следующий запуск обёртки — уже без параметров (SDK не успел отдать токен).
    go('?src=twa');
    expect(captureNativePushToken()).toBeNull();

    expect(window.location.search).toBe('?src=twa');
    expect(getNativePushState().record).toMatchObject({ provider: 'hms', token: TOKEN });
  });

  it('тот же токен на повторном запуске не сбрасывает регистрацию', () => {
    go(`?push_provider=rustore&push_token=${TOKEN}&app_id=porukam.app`);
    captureNativePushToken(new Date('2026-09-10T10:00:00.000Z'));
    updateNativePushRecord({ registeredAt: '2026-09-10T10:01:00.000Z', registeredFor: 'u-1' });

    go(`?push_provider=rustore&push_token=${TOKEN}&app_id=porukam.app`);
    const again = captureNativePushToken(new Date('2026-09-10T18:00:00.000Z'));

    expect(again).toMatchObject({
      receivedAt: '2026-09-10T10:00:00.000Z',
      registeredAt: '2026-09-10T10:01:00.000Z',
      registeredFor: 'u-1',
    });
  });

  it('новый токен (SDK сообщил onNewToken) стирает прежнюю регистрацию', () => {
    go(`?push_provider=rustore&push_token=${TOKEN}&app_id=porukam.app`);
    captureNativePushToken();
    updateNativePushRecord({ registeredAt: '2026-09-10T10:01:00.000Z', registeredFor: 'u-1' });

    go('?push_provider=rustore&push_token=NEW-token&app_id=porukam.app');
    const next = captureNativePushToken();

    expect(next).toMatchObject({ token: 'NEW-token' });
    expect(next?.registeredAt).toBeUndefined();
    expect(next?.registeredFor).toBeUndefined();
  });

  it('битая запись в хранилище равносильна её отсутствию', () => {
    localStorage.setItem(NATIVE_PUSH_STORAGE_KEY, '{не json');
    expect(getNativePushState()).toEqual({ active: false, record: null });
  });
});

describe('needsNativePushRegister — когда токен подтверждают на бэке', () => {
  const base: NativePushRecord = {
    provider: 'rustore',
    token: TOKEN,
    appId: 'porukam.app',
    receivedAt: '2026-09-10T10:00:00.000Z',
  };
  const now = new Date('2026-09-11T10:00:00.000Z');

  it('не регистрировали ни разу', () => {
    expect(needsNativePushRegister(base, 'u-1', now)).toBe(true);
  });

  it('владелец сменился — в приложение вошли другим аккаунтом', () => {
    const rec = { ...base, registeredAt: '2026-09-11T09:00:00.000Z', registeredFor: 'u-1' };
    expect(needsNativePushRegister(rec, 'u-2', now)).toBe(true);
  });

  it('свежая регистрация того же владельца — повтор не нужен', () => {
    const rec = { ...base, registeredAt: '2026-09-11T09:00:00.000Z', registeredFor: 'u-1' };
    expect(needsNativePushRegister(rec, 'u-1', now)).toBe(false);
  });

  it('прошли сутки — подтверждаем last_seen', () => {
    const rec = { ...base, registeredAt: '2026-09-10T09:00:00.000Z', registeredFor: 'u-1' };
    expect(needsNativePushRegister(rec, 'u-1', now)).toBe(true);
  });
});

describe('registerNativePushToken / unregisterNativePushToken — контракт бэка', () => {
  const record: NativePushRecord = {
    provider: 'fcm',
    token: TOKEN,
    appId: 'porukam.app',
    receivedAt: '2026-09-10T10:00:00.000Z',
  };

  beforeEach(() => {
    localStorage.removeItem(NATIVE_PUSH_STORAGE_KEY);
    useAuthStore.getState().setTokens({ access: 'u-1', refresh: 'r' });
  });
  afterEach(() => {
    useAuthStore.getState().logout();
    localStorage.removeItem(NATIVE_PUSH_STORAGE_KEY);
  });

  it('регистрация: 201 и строка на бэке', async () => {
    await expect(registerNativePushToken(record)).resolves.toEqual({ ok: true });
    expect(deviceTokens.get(TOKEN)).toMatchObject({ provider: 'fcm', app_id: 'porukam.app', platform: 'android' });
  });

  it('без входа — молчаливый `unauthorized`, а не ошибка канала', async () => {
    useAuthStore.getState().logout();
    await expect(registerNativePushToken(record)).resolves.toEqual({ ok: false, reason: 'unauthorized' });
  });

  it('снятие при выходе не удаляет локальную запись — токен принадлежит устройству', async () => {
    localStorage.setItem(
      NATIVE_PUSH_STORAGE_KEY,
      JSON.stringify({ ...record, registeredFor: 'u-1', registeredAt: '2026-09-10T10:01:00.000Z' }),
    );
    await registerNativePushToken(record);

    await unregisterNativePushToken();

    expect(deviceTokens.has(TOKEN)).toBe(false);
    expect(getNativePushState().record).toMatchObject({ token: TOKEN });
    expect(getNativePushState().record?.registeredFor).toBeUndefined();
  });
});
