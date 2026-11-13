import { describe, it, expect, beforeEach } from 'vitest';
import type { RealTimelineEvent } from '@porukam/core';
import {
  hasUnseenMaterialsChange,
  isMaterialChangeEvent,
  lastCounterpartyMaterialChange,
  markMaterialsSeen,
  maxSeenAt,
  readMaterialsSeenAt,
} from '../src/features/contracts/materialsChanged';

/**
 * Признак «контрагент правил материалы» (ADR-156/157) — чистая часть.
 * Источник факта — хроника договора, поэтому проверяем ровно её разбор:
 * какие топики считаются правкой, чьё событие «моё», и как отметка просмотра
 * гасит бейдж.
 */
function event(over: Partial<RealTimelineEvent> = {}): RealTimelineEvent {
  return {
    event_id: 'te-x',
    topic: 'milestone.material_updated',
    nested: true,
    occurred_at: '2026-09-03T10:00:00Z',
    actor: { user_id: 'u-counterparty' },
    subject: { type: 'milestone', id: 'ms-1', title: 'Шкаф-купе' },
    payload: {},
    ...over,
  };
}

describe('materialsChanged — разбор хроники', () => {
  it('правкой материалов считаются ровно три топика', () => {
    expect(isMaterialChangeEvent(event({ topic: 'milestone.material_added' }))).toBe(true);
    expect(isMaterialChangeEvent(event({ topic: 'milestone.material_updated' }))).toBe(true);
    expect(isMaterialChangeEvent(event({ topic: 'milestone.material_removed' }))).toBe(true);
    expect(isMaterialChangeEvent(event({ topic: 'milestone.accepted' }))).toBe(false);
    expect(isMaterialChangeEvent(event({ topic: 'milestone.checklist_added' }))).toBe(false);
  });

  it('берёт САМОЕ СВЕЖЕЕ чужое событие, даже если лента пришла не по порядку', () => {
    const fact = lastCounterpartyMaterialChange(
      [
        event({ event_id: 'a', occurred_at: '2026-09-03T12:00:00Z', subject: { type: 'milestone', id: 'ms-2', title: 'Стеллаж' } }),
        event({ event_id: 'b', occurred_at: '2026-09-03T09:00:00Z' }),
      ],
      { userId: 'u-me' },
    );
    expect(fact?.at).toBe('2026-09-03T12:00:00Z');
    expect(fact?.milestoneId).toBe('ms-2');
    expect(fact?.milestoneTitle).toBe('Стеллаж');
  });

  it('СВОИ правки бейджа не поднимают — ни по user_id, ни по роли', () => {
    expect(lastCounterpartyMaterialChange([event({ actor: { user_id: 'u-me' } })], { userId: 'u-me' })).toBeNull();
    expect(lastCounterpartyMaterialChange([event({ actor: { role: 'customer' } })], { role: 'customer' })).toBeNull();
    expect(lastCounterpartyMaterialChange([event({ actor: { role: 'contractor' } })], { role: 'customer' })).not.toBeNull();
  });

  it('актора определить нельзя — молчим (ложный значок внимания дороже пропущенного)', () => {
    expect(lastCounterpartyMaterialChange([event({ actor: {} })], { userId: 'u-me' })).toBeNull();
    expect(lastCounterpartyMaterialChange([event()], { userId: null, role: null })).toBeNull();
  });

  it('пустая лента и отсутствие ленты — без факта', () => {
    expect(lastCounterpartyMaterialChange([], { userId: 'u-me' })).toBeNull();
    expect(lastCounterpartyMaterialChange(undefined, { userId: 'u-me' })).toBeNull();
  });
});

describe('materialsChanged — отметка просмотра', () => {
  beforeEach(() => localStorage.clear());

  it('без отметки бейдж виден, после отметки той же правки — нет', () => {
    const fact = { at: '2026-09-03T10:00:00Z', milestoneId: 'ms-1', milestoneTitle: 'Шкаф-купе' };
    expect(hasUnseenMaterialsChange(fact, null)).toBe(true);
    expect(hasUnseenMaterialsChange(fact, '2026-09-03T10:00:00Z')).toBe(false);
  });

  it('правка ПОСЛЕ просмотра поднимает бейдж заново', () => {
    const fact = { at: '2026-09-03T11:00:00Z', milestoneId: 'ms-1', milestoneTitle: null };
    expect(hasUnseenMaterialsChange(fact, '2026-09-03T10:00:00Z')).toBe(true);
  });

  it('локальный кэш хранится по паре договор+профиль', () => {
    markMaterialsSeen('rc-1', 'pf-a', '2026-09-03T10:00:00Z');
    expect(readMaterialsSeenAt('rc-1', 'pf-a')).toBe('2026-09-03T10:00:00Z');
    expect(readMaterialsSeenAt('rc-1', 'pf-b')).toBeNull();
    expect(readMaterialsSeenAt('rc-2', 'pf-a')).toBeNull();
  });
});

/**
 * ADR-158: источник правды — серверная отметка стороны
 * (`contract.materials_seen_at`), локальная осталась оптимистичным кэшем.
 * Эффективная отметка — поздняя из двух.
 */
describe('materialsChanged — серверная отметка поверх локального кэша', () => {
  it('берётся ПОЗДНЯЯ из двух — в обе стороны', () => {
    expect(maxSeenAt('2026-09-03T12:00:00Z', '2026-09-03T10:00:00Z')).toBe('2026-09-03T12:00:00Z');
    expect(maxSeenAt('2026-09-03T10:00:00Z', '2026-09-03T12:00:00Z')).toBe('2026-09-03T12:00:00Z');
  });

  it('одна половина пустая — работает вторая', () => {
    expect(maxSeenAt(null, '2026-09-03T10:00:00Z')).toBe('2026-09-03T10:00:00Z');
    expect(maxSeenAt('2026-09-03T10:00:00Z', null)).toBe('2026-09-03T10:00:00Z');
    expect(maxSeenAt(null, null)).toBeNull();
  });

  it('нечитаемое значение игнорируется, а не побеждает', () => {
    expect(maxSeenAt('позавчера', '2026-09-03T10:00:00Z')).toBe('2026-09-03T10:00:00Z');
    expect(maxSeenAt('2026-09-03T10:00:00Z', 'позавчера')).toBe('2026-09-03T10:00:00Z');
    expect(maxSeenAt('позавчера', null)).toBeNull();
  });

  it('серверная отметка гасит бейдж без локального кэша (смена устройства)', () => {
    const fact = { at: '2026-09-03T10:00:00Z', milestoneId: 'ms-1', milestoneTitle: null };
    expect(hasUnseenMaterialsChange(fact, maxSeenAt('2026-09-03T11:00:00Z', null))).toBe(false);
    expect(hasUnseenMaterialsChange(fact, maxSeenAt('2026-09-03T09:00:00Z', null))).toBe(true);
  });
});
