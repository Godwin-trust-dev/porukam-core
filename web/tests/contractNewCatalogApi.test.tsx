import { describe, it, expect } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import {
  useContractTypes,
  useSpheres,
  useWorkTypes,
  useMaterialCatalog,
  useUnits,
  useChecklistRecommendations,
} from '../src/features/contractNew/api';

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

/**
 * DEV-09 §3/§4 — справочники мастера договора (ADR-091: реальный бэк читает
 * apps.catalog; здесь — мок, `web/src/mocks/catalog.ts`/`contractHandlers.ts`,
 * контракт формы совпадает с реальным один в один, ADR-091 §1 — типы
 * `packages/core` не менялись). Проверяем ТОЛЬКО проводку хуков (пути,
 * query-параметры, форма ответа) — не конкретные данные мока.
 */
describe('features/contractNew/api.ts — справочники мастера (ADR-091)', () => {
  it('useContractTypes(clientOption) — коды клиентского дерева выбранной опции (ADR-094)', async () => {
    const { result } = renderHook(() => useContractTypes('sale'), { wrapper });
    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(result.current.data!.map((o) => o.code)).toEqual(['sale_personal', 'sale_business']);
    expect(result.current.data!.every((o) => o.client_option === 'sale')).toBe(true);
  });

  it('useContractTypes(null) не запускает запрос (услуге код не нужен — резолвит сервер)', () => {
    const { result } = renderHook(() => useContractTypes(null), { wrapper });
    expect(result.current.fetchStatus).toBe('idle');
    expect(result.current.data).toBeUndefined();
  });

  it('useSpheres() без q — непустой список, каждая сфера с code/name', async () => {
    const { result } = renderHook(() => useSpheres(''), { wrapper });
    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(result.current.data!.results.length).toBeGreaterThan(0);
    for (const s of result.current.data!.results) {
      expect(typeof s.code).toBe('string');
      expect(typeof s.name).toBe('string');
    }
  });

  it('useSpheres(q) — нечёткий поиск: опечатка находит сферу (ADR-097)', async () => {
    const { result } = renderHook(() => useSpheres('римонт'), { wrapper });
    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(result.current.data!.results.map((s) => s.code)).toContain('repair');
  });

  it('useSpheres(q) — лишнее слово не даёт пустоту (запрос из плейсхолдера)', async () => {
    const { result } = renderHook(() => useSpheres('ремонт кухни'), { wrapper });
    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(result.current.data!.results.map((s) => s.code)).toContain('repair');
  });

  it('useSpheres(q) сужает список по имени', async () => {
    const { result } = renderHook(() => useSpheres('Ремонт'), { wrapper });
    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(result.current.data!.results.every((s) => s.name.toLowerCase().includes('ремонт'))).toBe(true);
  });

  it('useWorkTypes(sphereCode) — виды работ только выбранной сферы', async () => {
    const { result } = renderHook(() => useWorkTypes('repair'), { wrapper });
    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(result.current.data!.length).toBeGreaterThan(0);
    expect(result.current.data!.every((w) => w.sphere_code === 'repair')).toBe(true);
  });

  it('useWorkTypes("") не запускает запрос (enabled=false)', () => {
    const { result } = renderHook(() => useWorkTypes(''), { wrapper });
    expect(result.current.fetchStatus).toBe('idle');
    expect(result.current.data).toBeUndefined();
  });

  it('useMaterialCatalog() — непустой каталог, ref/title на каждой позиции', async () => {
    const { result } = renderHook(() => useMaterialCatalog(), { wrapper });
    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(result.current.data!.length).toBeGreaterThan(0);
    for (const m of result.current.data!) {
      expect(typeof m.ref).toBe('string');
      expect(typeof m.title).toBe('string');
    }
  });

  it('useUnits() — непустой список единиц измерения', async () => {
    const { result } = renderHook(() => useUnits(), { wrapper });
    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(result.current.data!.length).toBeGreaterThan(0);
  });

  it('useChecklistRecommendations(sphere, workType) — плоский список строк', async () => {
    const { result } = renderHook(() => useChecklistRecommendations('finishing', 'finishing_tiling'), { wrapper });
    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(Array.isArray(result.current.data)).toBe(true);
    expect(result.current.data!.every((r) => typeof r === 'string')).toBe(true);
  });

  it('useChecklistRecommendations без sphere ИЛИ без workType не запускает запрос', () => {
    const noSphere = renderHook(() => useChecklistRecommendations('', 'finishing_tiling'), { wrapper });
    expect(noSphere.result.current.fetchStatus).toBe('idle');
    const noWorkType = renderHook(() => useChecklistRecommendations('repair', ''), { wrapper });
    expect(noWorkType.result.current.fetchStatus).toBe('idle');
  });
});
