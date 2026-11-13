import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { createI18n } from '@porukam/i18n';

/**
 * Протухшая оболочка после деплоя (регрессия 01.09, «всё по-английски»).
 *
 * Имена чанков несут хеш содержимого — деплой их меняет, и `import()` старого
 * имени падает 404. 27 из 29 языков лежат ленивыми чанками (ADR-089), поэтому
 * молчаливое проглатывание этой ошибки давало «язык выбран, текст английский».
 */
describe('восстановление после протухшего чанка', () => {
  const reload = vi.fn();

  beforeEach(() => {
    vi.resetModules();
    reload.mockClear();
    sessionStorage.clear();
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...window.location, reload },
    });
  });

  afterEach(() => vi.restoreAllMocks());

  it('первый провал чанка — перезагрузка; второй в той же вкладке — уже нет', async () => {
    const { recoverFromStaleChunk } = await import('../src/app/chunkRecovery');

    expect(recoverFromStaleChunk()).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);

    // Ограничение обязательно: если чанка нет не из-за деплоя (сломанная
    // сборка, offline), безусловная перезагрузка дала бы бесконечный цикл.
    expect(recoverFromStaleChunk()).toBe(false);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('недоступный sessionStorage не приводит к перезагрузке без счётчика', async () => {
    const { recoverFromStaleChunk } = await import('../src/app/chunkRecovery');
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('приватный режим');
    });

    expect(recoverFromStaleChunk()).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });

  it('applyLocale: упавший пакет запускает восстановление, а не молчаливый EN', async () => {
    vi.doMock('@porukam/i18n', async () => {
      const real = await vi.importActual<typeof import('@porukam/i18n')>('@porukam/i18n');
      return { ...real, loadLocaleResources: vi.fn().mockRejectedValue(new Error('404 chunk')) };
    });
    const { applyLocale } = await import('../src/features/locale/applyLocale');
    const i18n = createI18n('en');

    await applyLocale(i18n, 'de');
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('applyLocale: язык, которого нет в сборке, перезагрузкой НЕ лечится', async () => {
    // `loadLocaleResources` отдаёт false БЕЗ исключения — это продуктовое
    // состояние, а не протухшая оболочка: перезагружаться незачем.
    vi.doMock('@porukam/i18n', async () => {
      const real = await vi.importActual<typeof import('@porukam/i18n')>('@porukam/i18n');
      return { ...real, loadLocaleResources: vi.fn().mockResolvedValue(false) };
    });
    const { applyLocale } = await import('../src/features/locale/applyLocale');
    const i18n = createI18n('en');

    await applyLocale(i18n, 'xx');
    expect(reload).not.toHaveBeenCalled();
    expect(i18n.language).toBe('xx');
  });
});
