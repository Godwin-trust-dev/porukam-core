import { describe, expect, it } from 'vitest';

import { contractTabFromHash, legacyContractTabFromHash } from '../src/features/contracts/cardDeepLink';

/**
 * ADR-170: уведомление открывает раздел, о котором пришло. Бэк отдаёт раздел
 * якорем `action.href`; здесь проверяется разбор якоря в ключ вкладки.
 */

const ALL = { chat: true, amendments: true };
const BARE = { chat: false, amendments: false };

describe('contractTabFromHash', () => {
  it.each([
    ['#overview', 'overview'],
    ['#terms', 'terms'],
    ['#stages', 'stages'],
    ['#payments', 'payments'],
    ['#chat', 'chat'],
    ['#negoSign', 'negoSign'],
    ['#amendments', 'amendments'],
    ['#timeline', 'timeline'],
  ])('%s → вкладка %s', (hash, tab) => {
    expect(contractTabFromHash(hash, ALL)).toBe(tab);
  });

  it('якорь этапа (ADR-156 §3) открывает «Этапы» — прокрутка за браузером', () => {
    expect(contractTabFromHash('#milestone-01a02359-6ef5-7466-8712-ef63299b169b', ALL)).toBe('stages');
  });

  it.each(['', '#', '#unknown', '#milestone', 'negoSign', '#Payments'])(
    'неизвестный хеш %j игнорируется, а не сбивает вкладку',
    (hash) => {
      expect(contractTabFromHash(hash, ALL)).toBeNull();
    },
  );

  it('чат без второй стороны — обзор, а не пустая вкладка', () => {
    expect(contractTabFromHash('#chat', BARE)).toBe('overview');
  });

  it('допники до подписания — обзор (вкладки ещё нет, ADR-161 §1)', () => {
    expect(contractTabFromHash('#amendments', BARE)).toBe('overview');
  });

  it('остальные разделы доступностью вкладок не ограничены', () => {
    expect(contractTabFromHash('#payments', BARE)).toBe('payments');
    expect(contractTabFromHash('#negoSign', BARE)).toBe('negoSign');
  });
});

describe('legacyContractTabFromHash (мок-карточка)', () => {
  it('«Переговоры и подписи» real-карточки — вкладка «Переговоры» мока', () => {
    expect(legacyContractTabFromHash('#negoSign')).toBe('nego');
  });

  it.each([
    ['#stages', 'stages'],
    ['#overview', 'overview'],
    ['#timeline', 'timeline'],
    ['#milestone-ms-2', 'stages'],
  ])('%s → %s', (hash, tab) => {
    expect(legacyContractTabFromHash(hash)).toBe(tab);
  });

  it.each(['#payments', '#terms', '#chat', '#amendments', '#unknown'])(
    'вкладки %j у мока нет — хеш игнорируется',
    (hash) => {
      expect(legacyContractTabFromHash(hash)).toBeNull();
    },
  );
});
