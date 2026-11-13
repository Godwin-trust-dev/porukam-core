import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  SW_UPDATE_MIN_INTERVAL_MS,
  SW_UPDATE_PERIOD_MS,
  startSwUpdateScheduler,
  type SwUpdateSchedulerDeps,
} from '../src/features/pwa/swUpdateScheduler';

/**
 * Планировщик проверок обновления SW (жалоба владельца 05.09: «на мобильном не предлагает
 * обновить»). Живого service worker в jsdom нет — модуль потому и принимает `update()` и
 * часы снаружи: проверяем ровно расписание, а не Workbox.
 */

/** Микротаски: `check()` асинхронный (probe → update), событие само его не дожидается. */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

let stop: (() => void) | null = null;
let clock = 0;
let updateCalls = 0;

function start(overrides: Partial<SwUpdateSchedulerDeps> = {}): void {
  stop?.();
  stop = startSwUpdateScheduler({
    update: () => {
      updateCalls += 1;
      return Promise.resolve();
    },
    now: () => clock,
    ...overrides,
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  clock = 1_000_000;
  updateCalls = 0;
});

afterEach(() => {
  stop?.();
  stop = null;
  vi.useRealTimers();
});

describe('startSwUpdateScheduler — возвращение приложения на передний план', () => {
  it('visibilitychange при видимой вкладке → проверка обновления', async () => {
    start({ isVisible: () => true });
    clock += SW_UPDATE_MIN_INTERVAL_MS;

    document.dispatchEvent(new Event('visibilitychange'));
    await flush();

    expect(updateCalls).toBe(1);
  });

  it('уход в фон (visibilityState !== visible) проверку не запускает', async () => {
    start({ isVisible: () => false });
    clock += SW_UPDATE_MIN_INTERVAL_MS;

    document.dispatchEvent(new Event('visibilitychange'));
    await flush();

    expect(updateCalls).toBe(0);
  });

  it('сразу после регистрации не дёргаем сеть: регистрация уже сходила за sw.js', async () => {
    start({ isVisible: () => true });

    document.dispatchEvent(new Event('visibilitychange'));
    await flush();

    expect(updateCalls).toBe(0);
  });

  it('дребезг: не чаще раза в 5 минут, сколько бы раз ни переключались между приложениями', async () => {
    start({ isVisible: () => true });
    clock += SW_UPDATE_MIN_INTERVAL_MS;

    for (let i = 0; i < 10; i += 1) {
      clock += 20_000; // 20 с между переключениями — как на телефоне
      document.dispatchEvent(new Event('visibilitychange'));
      await flush();
    }
    expect(updateCalls).toBe(1);

    clock += SW_UPDATE_MIN_INTERVAL_MS;
    document.dispatchEvent(new Event('visibilitychange'));
    await flush();
    expect(updateCalls).toBe(2);
  });
});

describe('startSwUpdateScheduler — таймер и сеть', () => {
  it('фоновая проверка раз в час', async () => {
    start({ isVisible: () => true });

    clock += SW_UPDATE_PERIOD_MS;
    await vi.advanceTimersByTimeAsync(SW_UPDATE_PERIOD_MS);
    await flush();
    expect(updateCalls).toBe(1);

    clock += SW_UPDATE_PERIOD_MS;
    await vi.advanceTimersByTimeAsync(SW_UPDATE_PERIOD_MS);
    await flush();
    expect(updateCalls).toBe(2);
  });

  it('офлайн → проверки нет (ни по таймеру, ни по возвращению на экран)', async () => {
    start({ isVisible: () => true, isOnline: () => false });
    clock += SW_UPDATE_PERIOD_MS;

    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(SW_UPDATE_PERIOD_MS);
    await flush();

    expect(updateCalls).toBe(0);
  });

  it('событие online → проверка (сеть вернулась — может быть, и новая сборка тоже)', async () => {
    start();
    clock += SW_UPDATE_MIN_INTERVAL_MS;

    window.dispatchEvent(new Event('online'));
    await flush();

    expect(updateCalls).toBe(1);
  });

  it('online и visibilitychange подряд (выход из авиарежима) — один запрос, не два', async () => {
    start({ isVisible: () => true });
    clock += SW_UPDATE_MIN_INTERVAL_MS;

    window.dispatchEvent(new Event('online'));
    document.dispatchEvent(new Event('visibilitychange'));
    await flush();

    expect(updateCalls).toBe(1);
  });
});

describe('startSwUpdateScheduler — предполётный запрос за sw.js', () => {
  it('200 → зовём update()', async () => {
    const seen: string[] = [];
    start({
      isVisible: () => true,
      swUrl: '/sw.js',
      probe: (url) => {
        seen.push(url);
        return Promise.resolve(true);
      },
    });
    clock += SW_UPDATE_MIN_INTERVAL_MS;

    document.dispatchEvent(new Event('visibilitychange'));
    await flush();

    expect(seen).toEqual(['/sw.js']);
    expect(updateCalls).toBe(1);
  });

  it('не 200 (лежит сервер, страница ошибки прокси) → update() не зовём', async () => {
    start({ isVisible: () => true, swUrl: '/sw.js', probe: () => Promise.resolve(false) });
    clock += SW_UPDATE_MIN_INTERVAL_MS;

    document.dispatchEvent(new Event('visibilitychange'));
    await flush();

    expect(updateCalls).toBe(0);
  });
});

describe('startSwUpdateScheduler — тихая деградация и очистка', () => {
  it('ошибка probe/update глотается, следующая проверка всё равно проходит', async () => {
    let calls = 0;
    stop?.();
    stop = startSwUpdateScheduler({
      now: () => clock,
      isVisible: () => true,
      update: () => {
        calls += 1;
        return calls === 1 ? Promise.reject(new Error('boom')) : Promise.resolve();
      },
    });

    clock += SW_UPDATE_MIN_INTERVAL_MS;
    document.dispatchEvent(new Event('visibilitychange'));
    await flush();
    expect(calls).toBe(1);

    clock += SW_UPDATE_MIN_INTERVAL_MS;
    document.dispatchEvent(new Event('visibilitychange'));
    await flush();
    expect(calls).toBe(2);
  });

  it('исключение из probe тоже не всплывает наружу', async () => {
    start({
      isVisible: () => true,
      swUrl: '/sw.js',
      probe: () => Promise.reject(new Error('offline')),
    });
    clock += SW_UPDATE_MIN_INTERVAL_MS;

    document.dispatchEvent(new Event('visibilitychange'));
    await flush();

    expect(updateCalls).toBe(0);
  });

  it('stop() снимает слушатели и таймер — после него ни одной проверки', async () => {
    start({ isVisible: () => true });
    stop?.();
    stop = null;

    clock += SW_UPDATE_PERIOD_MS;
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('online'));
    await vi.advanceTimersByTimeAsync(SW_UPDATE_PERIOD_MS * 2);
    await flush();

    expect(updateCalls).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
