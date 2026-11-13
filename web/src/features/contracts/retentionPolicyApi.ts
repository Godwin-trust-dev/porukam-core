/**
 * `GET /v1/evidence/retention-policy` (ADR-137, требование 9) — публичная
 * политика хранения документов сделки для блока `RetentionNotice`.
 *
 * Значения — настройка бэка (DeadlineKindConfig), меняются без релиза, но
 * не чаще, чем раз в месяцы: держим в кэше сутки и не перезапрашиваем на
 * каждом экране. Ответа может не быть (старый бэк, сеть, `null` по
 * незасеянной категории) — тогда константы ADR-137 (`resolveRetentionPolicy`),
 * блок рендерится всегда: ограничение срока обязано быть видно там же и так
 * же, как обещание.
 */
import { useQuery } from '@tanstack/react-query';
import { resolveRetentionPolicy, type ResolvedRetentionPolicy, type RetentionPolicy } from '@porukam/core';
import { api } from '../../shared/api';

export const RETENTION_POLICY_QUERY_KEY = ['evidence-retention-policy'] as const;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface RetentionPolicyState {
  policy: ResolvedRetentionPolicy;
  /** `true` — значения пришли с бэка; `false` — фолбэк ADR-137 (ещё грузится или ошибка). */
  fromApi: boolean;
}

export function useRetentionPolicy(): RetentionPolicyState {
  const q = useQuery({
    queryKey: RETENTION_POLICY_QUERY_KEY,
    queryFn: () => api.request<RetentionPolicy>('/evidence/retention-policy'),
    staleTime: DAY_MS,
    gcTime: DAY_MS,
    retry: 1,
  });
  return { policy: resolveRetentionPolicy(q.data), fromApi: q.isSuccess };
}
