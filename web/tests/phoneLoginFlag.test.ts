import { describe, it, expect } from 'vitest';
import { isPhoneLoginEnabled } from '../src/features/auth/phoneLoginFlag';

// docs/tasks/Задача_feat_web-global-entry.md §2 — телефонный вход спрятан за
// флагом, не удалён. Дефолт (переменная не выставлена — dev-сервер/vitest/
// Playwright/Storybook) — включён; прод-образ (конфиг nginx)
// собирается с VITE_PHONE_LOGIN_ENABLED=0.
describe('isPhoneLoginEnabled', () => {
  it('не выставлен — включён (dev/тесты/e2e не трогаем)', () => {
    expect(isPhoneLoginEnabled(undefined)).toBe(true);
  });

  it("'0' — выключен (прод-сборка на время ГВ)", () => {
    expect(isPhoneLoginEnabled('0')).toBe(false);
  });

  it("'1' — явно включён", () => {
    expect(isPhoneLoginEnabled('1')).toBe(true);
  });
});
