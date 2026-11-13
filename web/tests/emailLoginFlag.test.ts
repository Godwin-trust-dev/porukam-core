import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { isEmailLoginEnabled } from '../src/features/auth/emailLoginFlag';

/**
 * ADR-168 — вход по e-mail спрятан за флагом сборки, но в ОТЛИЧИЕ от
 * телефонного дефолт включён везде, включая прод-образ: `'0'` остаётся
 * аварийным рубильником, а не штатным состоянием прода.
 */
describe('isEmailLoginEnabled', () => {
  it('не выставлен — включён (дефолт: dev, тесты, e2e и прод-образ)', () => {
    expect(isEmailLoginEnabled(undefined)).toBe(true);
  });

  it("'1' — явно включён", () => {
    expect(isEmailLoginEnabled('1')).toBe(true);
  });

  it("'0' — выключен (аварийный рубильник)", () => {
    expect(isEmailLoginEnabled('0')).toBe(false);
  });
});

/**
 * Флаг выключен ⇒ маршрут `/login/email` не отдаёт форму, а уводит на
 * `/welcome` — тот же приём, что у `/login` при PHONE_LOGIN_ENABLED.
 * Проверяем конфигурацию роутера, а не рендер: элемент маршрута задаётся на
 * уровне модуля, и подмена флага возможна только через пересборку модулей.
 */
describe('маршрут /login/email при выключенном флаге', () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => {
    vi.doUnmock('../src/features/auth/emailLoginFlag');
    vi.resetModules();
  });

  async function routeElementFor(path: string): Promise<unknown> {
    const { router } = await import('../src/app/router');
    const route = router.routes.find((r) => r.path === path);
    expect(route, `маршрут ${path} должен быть в роутере`).toBeDefined();
    return (route as { element?: unknown }).element;
  }

  it("флаг '0' — вместо страницы редирект на /welcome", async () => {
    vi.doMock('../src/features/auth/emailLoginFlag', () => ({
      isEmailLoginEnabled: () => false,
      EMAIL_LOGIN_ENABLED: false,
    }));
    const element = (await routeElementFor('/login/email')) as {
      type: { name?: string };
      props: { to?: string };
    };
    expect(element.props.to).toBe('/welcome');
    // Каждая из двух проверок ниже поднимает ВЕСЬ роутер заново
    // (`vi.resetModules` + новый мок флага) — на машине разработчика это
    // 8-9 секунд против дефолтных пяти. Падало по таймауту, а не по сути.
  }, 20_000);

  it('дефолт — маршрут отдаёт саму страницу входа по почте', async () => {
    const element = (await routeElementFor('/login/email')) as {
      type: { name?: string };
      props: { to?: string };
    };
    expect(element.props.to).toBeUndefined();
    expect(element.type.name).toBe('EmailLoginPage');
  }, 20_000);
});
