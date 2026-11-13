import { useQuery } from '@tanstack/react-query';
import type { PaymentsSectionResponse, StagesSectionResponse } from '@porukam/core';
import { api } from '../../shared/api';
import { useAuthStore } from '../auth/authStore';

/**
 * Разделы `/stages`, `/payments`, `/disputes` (отсмотр 2026-08-22, ADR-109) —
 * кросс-договорные агрегаты. Стороны и платёжное состояние выводит бэкенд —
 * страницы только рендерят (CLAUDE.md web: компонент не знает про FSM).
 */

export function useStagesSection() {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  return useQuery({
    queryKey: ['dashboard', 'stages'],
    queryFn: () => api.request<StagesSectionResponse>('/dashboard/stages'),
    enabled: isAuthenticated,
  });
}

export function usePaymentsSection() {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  return useQuery({
    queryKey: ['dashboard', 'payments'],
    queryFn: () => api.request<PaymentsSectionResponse>('/dashboard/payments'),
    enabled: isAuthenticated,
  });
}

// `useDisputes` переехал в `features/disputes/api.ts` (этап 7, ADR-131):
// разногласие перестало быть строкой агрегата раздела — у него своя карточка,
// действия и вложенные сущности, и хук ходит уже не за списком, а за целым
// контуром. Здесь остались только кросс-договорные агрегаты дашборда.
