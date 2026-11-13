import { describe, it, expect, afterEach, vi } from 'vitest';
import { PLAY_PACKAGE_NAME, PLAY_REFERRER, PLAY_STORE_URL, trackPlayClick } from '../src/features/pwa/playStore';

/**
 * Атрибуция установок из Google Play (ADR-171, docs/ops/play-console.md).
 *
 * Единственный способ увидеть в Play Console установки «с нашего сайта»
 * отдельно — параметр `referrer` в ссылке. Он обязан приехать в магазин уже
 * закодированным: иначе `&` внутри referrer разберётся как параметр самого
 * URL магазина, и вся атрибуция потеряется молча — консоль не сообщает о
 * потерянном referrer, просто показывает установки как органические.
 */
describe('playStore — ссылка на Google Play с атрибуцией', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('пакет зафиксирован консолью и не меняется', () => {
    expect(PLAY_PACKAGE_NAME).toBe('porukam.app');
    expect(PLAY_STORE_URL).toContain('id=porukam.app');
  });

  it('referrer приезжает URL-кодированным, единой строкой', () => {
    expect(PLAY_REFERRER).toBe(
      'utm_source%3Dporukam.app%26utm_medium%3Dsite%26utm_campaign%3Dinstall',
    );
    // Ключевое: внутри referrer НЕТ сырых `=` и `&` — иначе разбор URL
    // магазина съест хвост и канал сольётся с органикой.
    expect(PLAY_REFERRER).not.toMatch(/[&=]/);
    expect(PLAY_STORE_URL).toContain(`&referrer=${PLAY_REFERRER}`);
  });

  it('после декодирования это ровно те три UTM-метки, которые ждёт консоль', () => {
    const decoded = new URLSearchParams(decodeURIComponent(PLAY_REFERRER));
    expect(decoded.get('utm_source')).toBe('porukam.app');
    expect(decoded.get('utm_medium')).toBe('site');
    expect(decoded.get('utm_campaign')).toBe('install');
  });

  it('переход в магазин считается как намерение, а не как установка', () => {
    const fetchMock = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) =>
      Promise.resolve(new Response(null, { status: 204 })),
    );
    vi.stubGlobal('fetch', fetchMock);

    trackPlayClick();

    const init = fetchMock.mock.calls[0]?.[1];
    if (!init) throw new Error('событие play_click не отправлено');
    expect((JSON.parse(String(init.body)) as { kind: string }).kind).toBe('play_click');
  });
});
