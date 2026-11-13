import { useQuery } from '@tanstack/react-query';
import type { DashboardResponse } from '@porukam/core';
import { api } from '../../shared/api';
import { useActorKey } from '../actor/actorStore';

/**
 * Дашборд запуска (ADR-090): «что требует моего действия» по ВСЕМ моим
 * сделкам. Без параметров (`role`/`period` из старого мок-контракта убраны
 * целиком, ADR-090 §4) — «мои сделки» на экране берутся отдельным, уже
 * реальным `useRealContractsList()` (`features/contracts/realApi.ts`).
 */
export function useDashboard() {
  // Ключ актёра, а не только id профиля (ADR-129): контекст объединения —
  // такая же смена актёра, дашборд обязан перезапроситься и на ней.
  const actorKey = useActorKey();
  return useQuery({
    queryKey: ['dashboard', actorKey],
    queryFn: () => api.request<DashboardResponse>('/dashboard', { actor: true }),
  });
}
