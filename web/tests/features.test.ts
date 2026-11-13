import { describe, expect, it } from 'vitest';
import { isFeatureEnabled } from '../src/shared/features';

/** Чат (ADR-112), поиск и объединения (ADR-114) включены; организации и соцссылки — ещё нет. */
describe('фич-флаги разделов', () => {
  it('chat/search/groups включены по умолчанию', () => {
    for (const key of ['chat', 'search', 'groups'] as const) {
      expect(isFeatureEnabled(key)).toBe(true);
    }
  });

  it('organizations/socialLinks выключены по умолчанию', () => {
    for (const key of ['organizations', 'socialLinks'] as const) {
      expect(isFeatureEnabled(key)).toBe(false);
    }
  });
});
