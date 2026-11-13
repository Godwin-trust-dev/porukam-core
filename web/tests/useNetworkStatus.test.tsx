import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useNetworkStatus } from '../src/features/pwa/useNetworkStatus';

describe('useNetworkStatus (DEV-15 §3)', () => {
  it('реагирует на события online/offline', () => {
    const { result } = renderHook(() => useNetworkStatus());
    expect(result.current).toBe(true);

    act(() => window.dispatchEvent(new Event('offline')));
    expect(result.current).toBe(false);

    act(() => window.dispatchEvent(new Event('online')));
    expect(result.current).toBe(true);
  });
});
