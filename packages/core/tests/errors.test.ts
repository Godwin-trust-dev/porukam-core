import { describe, it, expect } from 'vitest';
import { ApiError, mapErrorToAction } from '../src/errors';

describe('ApiError / mapErrorToAction', () => {
  it('403 verification_required → запуск ЕСИА с требуемым уровнем', () => {
    const e = new ApiError(403, { code: 'verification_required', required_level: 'verified' });
    expect(mapErrorToAction(e)).toEqual({ kind: 'start_esia', requiredLevel: 'verified' });
  });

  it('409 version_stale → перезагрузка ресурса', () => {
    const e = new ApiError(409, { code: 'version_stale' });
    expect(mapErrorToAction(e).kind).toBe('reload_resource');
  });

  it('429 → бэкофф с Retry-After', () => {
    const e = new ApiError(429, { retry_after: 30 });
    expect(e.code).toBe('rate_limited');
    expect(mapErrorToAction(e)).toEqual({ kind: 'backoff', retryAfter: 30 });
  });

  it('404 → трактуется как «нет объекта» (приватность не раскрывается)', () => {
    const e = new ApiError(404, {});
    expect(e.code).toBe('not_found');
    expect(mapErrorToAction(e).kind).toBe('treat_as_absent');
  });

  it('checklist_item_required / entity_not_operable → точечная подсказка', () => {
    expect(mapErrorToAction(new ApiError(422, { code: 'checklist_item_required' })).kind).toBe('inline_hint');
    expect(mapErrorToAction(new ApiError(403, { code: 'entity_not_operable' })).kind).toBe('inline_hint');
  });

  it('is() удобно проверяет код', () => {
    expect(new ApiError(409, { code: 'contract_fee_charge_failed' }).is('contract_fee_charge_failed')).toBe(true);
  });
});
