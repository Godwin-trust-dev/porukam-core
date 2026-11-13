import { describe, expect, it } from 'vitest';
import { NAVIGATE_FALLBACK_DENYLIST, usesNavigationFallback } from '../src/features/pwa/navigateFallbackDenylist';

/**
 * Сторож инцидента 03.09 (docs/backlog.md): service worker подменял оболочкой SPA
 * долгоживущую ссылку на архив `/a/<token>` (ADR-139 §7) — запрос не доходил до
 * nginx вообще. Здесь фиксируются ОБЕ стороны правила: пути бэкенда обязаны
 * уходить в сеть, клиентские маршруты — обязаны получать оболочку офлайн.
 */
describe('navigateFallbackDenylist', () => {
  it.each([
    ['/a/xyz', 'ссылка на архив сделки (ADR-139 §7)'],
    ['/a/Mzs-9Q_toKen', 'токен из письма — с дефисом и подчёркиванием (token_urlsafe)'],
    ['/v1/health', 'health бэкенда'],
    ['/v1/archive/exports', 'REST API'],
    ['/admin/', 'Django admin'],
    ['/admin/archive/archivelink/', 'вложенный путь админки'],
    ['/ws/chat/c-1', 'WebSocket чата (ADR-113)'],
    ['/.well-known/assetlinks.json', 'верификация TWA (ADR-150) — обязан быть JSON, не HTML'],
    ['/grafana/', 'мониторинг за basic auth'],
    ['/prometheus/', 'мониторинг за basic auth'],
    ['/alertmanager/', 'мониторинг за basic auth'],
  ])('%s — мимо оболочки, в сеть (%s)', (path) => {
    expect(usesNavigationFallback(path)).toBe(false);
  });

  it.each([
    ['/', 'корень'],
    ['/contracts/1', 'карточка договора'],
    ['/contracts/c-9301/archive', 'экран архива сделки'],
    ['/welcome', 'публичный вход'],
    ['/legal/offer?lang=en', 'юрдокумент с query — денилист сверяет pathname + search'],
    ['/@ivan', 'публичная карточка репутации'],
    ['/me/settings/app', 'вложенный клиентский маршрут'],
  ])('%s — оболочка SPA (%s)', (path) => {
    expect(usesNavigationFallback(path)).toBe(true);
  });

  it('денилист сверяется по склейке pathname + search — как в workbox NavigationRoute', () => {
    // Страховочный маршрут /a/* в роутере уходит на сервер с меткой ?swbypass=1;
    // если она вдруг попадёт под fallback — получится вечный цикл «оболочка → оболочка».
    expect(usesNavigationFallback('/a/xyz?swbypass=1')).toBe(false);
    // Обратный случай: «/archive» — не «/a/», под денилист попадать не должен.
    expect(usesNavigationFallback('/archive')).toBe(true);
    expect(usesNavigationFallback('/administration')).toBe(true);
  });

  it('все выражения — привязаны к началу пути (чужой хвост не должен ловиться)', () => {
    for (const re of NAVIGATE_FALLBACK_DENYLIST) {
      expect(re.source.startsWith('^')).toBe(true);
      // Глобальный флаг у RegExp сделал бы `test()` зависимым от lastIndex —
      // workbox гоняет один и тот же объект на каждой навигации.
      expect(re.global).toBe(false);
    }
  });
});
