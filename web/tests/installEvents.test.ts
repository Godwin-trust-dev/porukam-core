import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  detectDisplayMode,
  detectPlatform,
  detectSource,
  trackInstallEvent,
  trackStandaloneOpen,
} from '../src/features/analytics/installEvents';

/**
 * Воронка установки приложения (ADR-171) — отправка событий и суточный дедуп
 * «открыли установленное приложение».
 *
 * Проверяется именно то, ради чего слой заведён и на чём он держится: событие
 * уходит fire-and-forget и не может уронить установку; в теле нет ни строки
 * User-Agent, ни адреса, ни отпечатка; `standalone_open` считается раз в сутки
 * на устройство, а не на каждый переход по страницам.
 */
function mockFetch(): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(() => Promise.resolve(new Response(null, { status: 204 })));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function body(fetchMock: ReturnType<typeof vi.fn>, call = 0): Record<string, unknown> {
  const args = fetchMock.mock.calls[call];
  if (!args) throw new Error(`отправки №${call} не было`);
  const init = args[1] as RequestInit;
  return JSON.parse(String(init.body)) as Record<string, unknown>;
}

function setStandalone(matches: boolean): void {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      matches: matches && query.includes('standalone'),
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
  window.matchMedia = globalThis.matchMedia;
}

describe('installEvents — воронка установки (ADR-171)', () => {
  beforeEach(() => {
    localStorage.clear();
    setStandalone(false);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it('отправляет событие на /v1/analytics/install-event с keepalive', () => {
    const fetchMock = mockFetch();
    trackInstallEvent('pwa_installed');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/v1/analytics/install-event');
    expect(init.method).toBe('POST');
    // keepalive — то же главное свойство, что у sendBeacon: запрос переживает
    // уход со страницы, а установка приложения — ровно такой уход.
    expect(init.keepalive).toBe(true);
    expect(body(fetchMock).kind).toBe('pwa_installed');
  });

  it('в теле нет ни User-Agent, ни адреса, ни отпечатка устройства', () => {
    const fetchMock = mockFetch();
    trackInstallEvent('install_click');

    expect(Object.keys(body(fetchMock)).sort()).toEqual([
      'display_mode',
      'kind',
      'platform',
      'source',
    ]);
  });

  it('провал отправки не выбрасывает наружу — аналитика не ломает установку', async () => {
    const fetchMock = vi.fn(() => Promise.reject(new Error('офлайн')));
    vi.stubGlobal('fetch', fetchMock);

    expect(() => trackInstallEvent('install_prompt_shown')).not.toThrow();
    // Даём отклонённому промису дойти до .catch(), иначе vitest увидит
    // unhandled rejection и упадёт уже на нём.
    await Promise.resolve();
  });

  it('standalone_open считается раз в сутки на устройство', () => {
    setStandalone(true);
    const fetchMock = mockFetch();

    expect(trackStandaloneOpen(new Date('2026-09-07T08:00:00Z'))).toBe(true);
    // Второй заход в тот же день — переход по страницам, а не новое
    // использование приложения: считать его значило бы мерить не людей.
    expect(trackStandaloneOpen(new Date('2026-09-07T21:00:00Z'))).toBe(false);
    expect(trackStandaloneOpen(new Date('2026-09-08T07:00:00Z'))).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('в обычной вкладке standalone_open не отправляется вовсе', () => {
    const fetchMock = mockFetch();
    expect(trackStandaloneOpen()).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('запрет localStorage не отменяет отправку — точность теряем, факт нет', () => {
    setStandalone(true);
    const fetchMock = mockFetch();
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('приватный режим');
    });

    expect(trackStandaloneOpen()).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    getItem.mockRestore();
  });

  it('платформа — грубая корзина, а не строка UA', () => {
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (Linux; Android 13; SM-S908B)', maxTouchPoints: 5 });
    expect(detectPlatform()).toBe('android');
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)', maxTouchPoints: 5 });
    expect(detectPlatform()).toBe('ios');
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', maxTouchPoints: 0 });
    expect(detectPlatform()).toBe('desktop');
    vi.stubGlobal('navigator', { userAgent: 'КакойТоНезнакомыйКлиент/1.0', maxTouchPoints: 0 });
    expect(detectPlatform()).toBe('other');
  });

  it('TWA из Google Play опознаётся по android-app:// как standalone и источник play', () => {
    Object.defineProperty(document, 'referrer', {
      configurable: true,
      value: 'android-app://porukam.app/',
    });
    expect(detectDisplayMode()).toBe('standalone');
    expect(detectSource()).toBe('play');
    Object.defineProperty(document, 'referrer', { configurable: true, value: '' });
  });

  it('обычная вкладка не выдумывает источник установки', () => {
    expect(detectSource()).toBe('unknown');
  });
});
