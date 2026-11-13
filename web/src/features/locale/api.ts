import { useQuery } from '@tanstack/react-query';
import type { LocaleInfo } from '@porukam/core';
import { api } from '../../shared/api';

/** GET /v1/locales (DEV-16a §3) — публичный, доступен гостю до логина. */
export function useLocales() {
  return useQuery({
    queryKey: ['locales'],
    queryFn: () => api.request<LocaleInfo[]>('/locales'),
    staleTime: 60 * 60_000, // справочник, не меняется в рамках сессии
  });
}
