import { beforeEach, describe, expect, it } from 'vitest';
import { AUTH_STORAGE_KEY, useAuthStore } from '../src/features/auth/authStore';
import { ACTOR_STORAGE_KEY, useActorStore } from '../src/features/actor/actorStore';

/** Сессия переживает перезагрузку вкладки (отсмотр прода 2026-08-21):
 * токены и способ входа — в localStorage, logout их стирает. */
describe('authStore persist', () => {
  beforeEach(() => {
    localStorage.clear();
    useAuthStore.getState().logout();
    useActorStore.getState().reset();
  });

  it('сохраняет пару токенов и loginMethod в localStorage', () => {
    useAuthStore.getState().setTokens({ access: 'a1', refresh: 'r1' }, 'google');
    const raw = JSON.parse(localStorage.getItem(AUTH_STORAGE_KEY) ?? '{}') as { state: Record<string, unknown> };
    expect(raw.state).toMatchObject({ access: 'a1', refresh: 'r1', isAuthenticated: true, loginMethod: 'google' });
  });

  it('регидратирует сессию из localStorage (эмуляция F5)', async () => {
    localStorage.setItem(
      AUTH_STORAGE_KEY,
      JSON.stringify({ state: { access: 'a2', refresh: 'r2', isAuthenticated: true, loginMethod: 'otp' }, version: 0 }),
    );
    await useAuthStore.persist.rehydrate();
    expect(useAuthStore.getState()).toMatchObject({ access: 'a2', isAuthenticated: true, loginMethod: 'otp' });
  });

  it('logout очищает и память, и хранилище', () => {
    useAuthStore.getState().setTokens({ access: 'a1', refresh: 'r1' });
    useAuthStore.getState().logout();
    const raw = JSON.parse(localStorage.getItem(AUTH_STORAGE_KEY) ?? '{}') as { state: Record<string, unknown> };
    expect(raw.state).toMatchObject({ access: null, refresh: null, isAuthenticated: false });
  });

  it('actorStore хранит только activeProfileId и сбрасывает его, если профиля больше нет', () => {
    useActorStore.getState().setProfiles([{ id: 'p1' }, { id: 'p2' }] as never);
    useActorStore.getState().setActive('p2');
    const raw = JSON.parse(localStorage.getItem(ACTOR_STORAGE_KEY) ?? '{}') as { state: Record<string, unknown> };
    expect(raw.state).toEqual({ activeProfileId: 'p2', activeGroupId: null });
    // Другой пользователь / профиль удалён — чужой id не держим.
    useActorStore.getState().setProfiles([{ id: 'x1' }] as never);
    expect(useActorStore.getState().activeProfileId).toBe('x1');
  });
});
