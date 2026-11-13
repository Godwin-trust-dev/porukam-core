import { describe, it, expect } from 'vitest';
import { RETENTION_POLICY_FALLBACK, humanizeDays, resolveRetentionPolicy } from '../src/retention';

// ADR-137: 3 месяца горячего → архив до 1 года, уведомление за 10 дней,
// при споре продление не более 6 месяцев после его завершения.
describe('humanizeDays', () => {
  it('кратно 365 — годы (без хардкода «год»)', () => {
    expect(humanizeDays(365)).toEqual({ unit: 'year', count: 1 });
    expect(humanizeDays(730)).toEqual({ unit: 'year', count: 2 });
  });
  it('кратно 30 — месяцы', () => {
    expect(humanizeDays(90)).toEqual({ unit: 'month', count: 3 });
    expect(humanizeDays(180)).toEqual({ unit: 'month', count: 6 });
    expect(humanizeDays(30)).toEqual({ unit: 'month', count: 1 });
  });
  it('остальное — дни (10, 14, 0)', () => {
    expect(humanizeDays(10)).toEqual({ unit: 'day', count: 10 });
    expect(humanizeDays(14)).toEqual({ unit: 'day', count: 14 });
    expect(humanizeDays(0)).toEqual({ unit: 'day', count: 0 });
  });
  it('360 — не год: 12 месяцев', () => {
    expect(humanizeDays(360)).toEqual({ unit: 'month', count: 12 });
  });
});

describe('resolveRetentionPolicy', () => {
  it('без ответа API — константы ADR-137 целиком', () => {
    expect(resolveRetentionPolicy(undefined)).toEqual(RETENTION_POLICY_FALLBACK);
    expect(resolveRetentionPolicy(null)).toEqual({
      hot_days: 90,
      archive_days: 365,
      notice_days: 10,
      dispute_pause_cap_days: 180,
      hashes_forever: true,
    });
  });
  it('`null` по одному полю (категория не засеяна) — фолбэк только по нему', () => {
    const r = resolveRetentionPolicy({ hot_days: 60, archive_days: null, notice_days: 7, dispute_pause_cap_days: null, hashes_forever: true });
    expect(r).toEqual({ hot_days: 60, archive_days: 365, notice_days: 7, dispute_pause_cap_days: 180, hashes_forever: true });
  });
  it('нули и отрицательные — не срок, фолбэк', () => {
    expect(resolveRetentionPolicy({ hot_days: 0, archive_days: -5 }).hot_days).toBe(90);
    expect(resolveRetentionPolicy({ hot_days: 0, archive_days: -5 }).archive_days).toBe(365);
  });
});
