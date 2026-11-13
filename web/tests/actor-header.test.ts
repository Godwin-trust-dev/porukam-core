import { describe, it, expect, beforeEach } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from '../src/mocks/server';
import { api } from '../src/shared/api';
import { useAuthStore } from '../src/features/auth/authStore';
import { useActorStore } from '../src/features/actor/actorStore';

/**
 * Критерий приёмки 5: переключатель актёра меняет X-Acting-Profile в мок-запросах.
 * Проверяем на уровне заголовков: мок-хендлер эхом возвращает полученный
 * X-Acting-Profile, а api-клиент подставляет его из actorStore.
 */
describe('X-Acting-Profile следует за контекстом актёра', () => {
  beforeEach(() => {
    useAuthStore.getState().setTokens({ access: 'a', refresh: 'r' });
    useActorStore.getState().reset();
    useActorStore.getState().setProfiles([
      {
        id: 'pf-person-1',
        kind: 'person',
        display_name: 'Физлицо',
        handle: '@me',
        verification_level: 'basic',
        has_business_status: false,
      },
      {
        id: 'pf-biz-1',
        kind: 'business',
        display_name: 'Бизнес',
        handle: '@biz',
        verification_level: 'verified',
        has_business_status: true,
      },
    ]);
    server.use(
      http.get('/v1/echo-actor', ({ request }) =>
        HttpResponse.json({ acting: request.headers.get('X-Acting-Profile') }),
      ),
    );
  });

  it('меняет заголовок при смене профиля', async () => {
    const first = await api.request<{ acting: string | null }>('/echo-actor', { actor: true });
    expect(first.acting).toBe('pf-person-1');

    useActorStore.getState().setActive('pf-biz-1');
    const second = await api.request<{ acting: string | null }>('/echo-actor', { actor: true });
    expect(second.acting).toBe('pf-biz-1');
  });

  it('личные эндпоинты идут без X-Acting-Profile', async () => {
    server.use(
      http.get('/v1/echo-actor-personal', ({ request }) =>
        HttpResponse.json({ acting: request.headers.get('X-Acting-Profile') }),
      ),
    );
    const res = await api.request<{ acting: string | null }>('/echo-actor-personal');
    expect(res.acting).toBeNull();
  });
});
