import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  INSTALL_BANNER_SNOOZE_MS,
  dismissInstall,
  isInstallDismissed,
  isMarkedInstalled,
  markInstalled,
} from '../src/features/pwa/installDismissed';

/**
 * «✕» на install-баннере = ОТЛОЖИТЬ на неделю (решение владельца 05.09). Раньше одно
 * касание крестика убирало предложение установить приложение навсегда — а нужно оно ровно
 * тем, кто ещё не поставил, поэтому обязано возвращаться.
 */

const DAY = 24 * 60 * 60 * 1000;
const LEGACY_KEY = 'porukam.installBannerDismissed';
const AT_KEY = 'porukam.installBannerDismissedAt';

describe('installDismissed — отложить на неделю, а не навсегда', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it('без закрытия баннер показывается', () => {
    expect(isInstallDismissed()).toBe(false);
  });

  it('сразу после «✕» — скрыт', () => {
    const now = Date.parse('2026-09-05T10:00:00Z');
    dismissInstall(now);
    expect(isInstallDismissed(now)).toBe(true);
  });

  it('через 6 дней — всё ещё скрыт', () => {
    const now = Date.parse('2026-09-05T10:00:00Z');
    dismissInstall(now);
    expect(isInstallDismissed(now + 6 * DAY)).toBe(true);
  });

  it('через 8 дней — предложение вернулось', () => {
    const now = Date.parse('2026-09-05T10:00:00Z');
    dismissInstall(now);
    expect(isInstallDismissed(now + 8 * DAY)).toBe(false);
  });

  it('порог — ровно неделя', () => {
    const now = 1_000_000_000;
    dismissInstall(now);
    expect(isInstallDismissed(now + INSTALL_BANNER_SNOOZE_MS - 1)).toBe(true);
    expect(isInstallDismissed(now + INSTALL_BANNER_SNOOZE_MS)).toBe(false);
  });

  it('повторное «✕» отсчитывает неделю заново', () => {
    const now = 1_000_000_000;
    dismissInstall(now);
    dismissInstall(now + 6 * DAY);
    expect(isInstallDismissed(now + 8 * DAY)).toBe(true);
    expect(isInstallDismissed(now + 14 * DAY)).toBe(false);
  });

  describe('миграция старого флага «закрыт навсегда»', () => {
    it('старый флаг = «закрыт сейчас»: неделя пойдёт от первого чтения, а не от установки апдейта', () => {
      localStorage.setItem(LEGACY_KEY, '1');
      const now = 1_000_000_000;

      // Иначе обновление выглядело бы как «баннер, который я закрыл, вернулся сам».
      expect(isInstallDismissed(now)).toBe(true);
      expect(isInstallDismissed(now + 6 * DAY)).toBe(true);
      expect(isInstallDismissed(now + 8 * DAY)).toBe(false);
    });

    it('после миграции старый ключ убран, отметка времени сохранена', () => {
      localStorage.setItem(LEGACY_KEY, '1');
      const now = 1_000_000_000;
      isInstallDismissed(now);

      expect(localStorage.getItem(LEGACY_KEY)).toBeNull();
      expect(localStorage.getItem(AT_KEY)).toBe(String(now));
    });

    it('битая отметка времени не блокирует баннер навсегда', () => {
      localStorage.setItem(AT_KEY, 'не-число');
      expect(isInstallDismissed()).toBe(false);
    });
  });

  it('флаг «установлено» — постоянный и не связан с откладыванием', () => {
    const now = 1_000_000_000;
    markInstalled();
    dismissInstall(now);

    expect(isMarkedInstalled()).toBe(true);
    // Неделя вышла — баннер бы вернулся, но `isStandalone` его снимает по этому флагу.
    expect(isInstallDismissed(now + 8 * DAY)).toBe(false);
    expect(isMarkedInstalled()).toBe(true);
  });
});
