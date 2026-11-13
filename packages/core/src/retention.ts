/**
 * Сроки хранения документов сделки (ADR-137). Чистые функции для блока
 * `RetentionNotice`: фолбэк на константы ADR, когда `GET /evidence/
 * retention-policy` недоступен или отдал `null`, и перевод дней в
 * человеческую единицу (`{ unit, count }`) — сам текст с плюрализацией
 * делает i18n (`contract.retention.years|months|days` с `{{count}}`), здесь
 * только арифметика.
 */
import type { RetentionPolicy } from './api/types';

export type ResolvedRetentionPolicy = { [K in keyof RetentionPolicy]: NonNullable<RetentionPolicy[K]> };

/** Значения ADR-137: 3 месяца горячего → архив до 1 года, уведомление за 10
 * дней, продление при споре не более 6 месяцев после его завершения. */
export const RETENTION_POLICY_FALLBACK: ResolvedRetentionPolicy = {
  hot_days: 90,
  archive_days: 365,
  notice_days: 10,
  dispute_pause_cap_days: 180,
  hashes_forever: true,
};

/** Подставляет фолбэк по каждому полю отдельно: бэк отдаёт `null` для
 * незасеянной категории, а не весь ответ целиком. */
export function resolveRetentionPolicy(policy: Partial<RetentionPolicy> | null | undefined): ResolvedRetentionPolicy {
  const days = (v: number | null | undefined, fallback: number): number =>
    typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v) : fallback;
  return {
    hot_days: days(policy?.hot_days, RETENTION_POLICY_FALLBACK.hot_days),
    archive_days: days(policy?.archive_days, RETENTION_POLICY_FALLBACK.archive_days),
    notice_days: days(policy?.notice_days, RETENTION_POLICY_FALLBACK.notice_days),
    dispute_pause_cap_days: days(policy?.dispute_pause_cap_days, RETENTION_POLICY_FALLBACK.dispute_pause_cap_days),
    hashes_forever: policy?.hashes_forever ?? RETENTION_POLICY_FALLBACK.hashes_forever,
  };
}

export type DurationUnit = 'year' | 'month' | 'day';

export interface HumanDuration {
  unit: DurationUnit;
  count: number;
}

/**
 * Дни → крупнейшая «ровная» единица: кратно 365 — годы, кратно 30 (от 30) —
 * месяцы, иначе дни. Так 90 → «3 месяца», 365 → «1 год», 10 → «10 дней»,
 * 180 → «6 месяцев»; «год» не хардкодится — при смене настроек бэка
 * (например 730) текст сам станет «2 года».
 */
export function humanizeDays(days: number): HumanDuration {
  const d = Math.max(0, Math.round(days));
  if (d >= 365 && d % 365 === 0) return { unit: 'year', count: d / 365 };
  if (d >= 30 && d % 30 === 0) return { unit: 'month', count: d / 30 };
  return { unit: 'day', count: d };
}
