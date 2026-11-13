import { describe, it, expect, beforeEach } from 'vitest';
import { db, MockError, resetContracts, resetPayouts } from '../src/mocks/contractsDb';

beforeEach(() => {
  resetContracts();
  resetPayouts();
});

/** DEV-10 · протокол разногласий — мок-движок напрямую по contractsDb (без React/MSW). */
describe('Мок-FSM согласования (DEV-10)', () => {
  it('чужая мультивариант → «Выбрать вариант» → применено, timeline и сумма обновились', () => {
    const id = 'c-6001';
    const before = db.get(id);
    const r = before.revisions.find((x) => x.author_role === 'contractor' && x.status === 'open' && x.variants.length > 1)!;
    const chosen = r.variants[0]!;
    const after = db.acceptRevision(id, r.id, 'customer', chosen.id);
    const rev = after.revisions.find((x) => x.id === r.id)!;
    expect(rev.status).toBe('accepted');
    expect(rev.chosen_variant_id).toBe(chosen.id);
    expect(after.timeline.at(-1)?.kind).toBe('revision.accepted');
  });

  it('нельзя принять собственную правку (симметрия)', () => {
    const id = 'c-6001';
    const c = db.get(id);
    const own = c.revisions.find((x) => x.author_role === 'customer' && x.status === 'open')!;
    expect(() => db.acceptRevision(id, own.id, 'customer', own.variants[0]!.id)).toThrow(MockError);
  });

  it('Отклонить → Встречная с 2 вариантами → исходная countered, новая от контрагента', () => {
    const id = 'c-6001';
    const c = db.get(id);
    const r = c.revisions.find((x) => x.author_role === 'contractor' && x.status === 'open' && x.variants.length > 1)!;
    db.rejectRevision(id, r.id, 'customer');
    expect(db.get(id).revisions.find((x) => x.id === r.id)?.status).toBe('rejected');

    const r2 = c.revisions.find((x) => x.author_role === 'customer' && x.status === 'open')!;
    const afterCounter = db.counterRevision(id, r2.id, 'contractor', [{ value: '44 000 ₽' }, { value: '46 000 ₽', note: 'со стяжкой' }], 'Встречное предложение');
    expect(afterCounter.revisions.find((x) => x.id === r2.id)?.status).toBe('countered');
    const created = afterCounter.revisions.find((x) => x.item_ref === r2.item_ref && x.status === 'open' && x.author_role === 'contractor');
    expect(created?.variants).toHaveLength(2);
    expect(created?.kind).toBe('counter');
  });

  it('предодобренная альтернатива → приём в 1 клик по выбранному варианту', () => {
    const id = 'c-6001';
    const alt = db.get(id).preapproved_alternatives[0]!;
    const variant = alt.variants[1]!;
    const after = db.applyPreapproved(id, alt.id, variant.id);
    expect(after.preapproved_alternatives.find((a) => a.id === alt.id)).toBeUndefined();
    expect(after.timeline.at(-1)?.kind).toBe('preapproved.applied');
  });

  it('«Принять все» с финансово значимыми правками требует confirm_summary; многовариантная не входит', () => {
    const id = 'c-6001';
    let threw: MockError | null = null;
    try {
      db.acceptAllRevisions(id, false);
    } catch (e) {
      threw = e as MockError;
    }
    expect(threw).toBeInstanceOf(MockError);
    expect(threw?.code).toBe('confirm_summary_required');
    const changes = threw?.extra.changes as { item_label: string }[];
    // Только однозначная правка (variants.length===1) — многовариантные исключены.
    expect(changes).toHaveLength(1);

    const after = db.acceptAllRevisions(id, true);
    const singleRev = after.revisions.find((r) => r.variants.length === 1)!;
    expect(singleRev.status).toBe('accepted');
    // Многовариантные остаются открытыми — выбираются поштучно.
    expect(after.revisions.filter((r) => r.status === 'open' && r.variants.length > 1)).toHaveLength(2);
  });

  it('своя правка → «Отозвать»; отозвать чужую нельзя', () => {
    const id = 'c-6001';
    const c = db.get(id);
    const mine = c.revisions.find((x) => x.author_role === 'customer' && x.status === 'open')!;
    expect(() => db.withdrawRevision(id, mine.id, 'contractor')).toThrow(MockError);
    const after = db.withdrawRevision(id, mine.id, 'customer');
    expect(after.revisions.find((x) => x.id === mine.id)?.status).toBe('withdrawn');
  });

  it('0 открытых правок → «Заморозить и подписать» доступно', () => {
    const id = 'c-6002';
    expect(db.get(id).revisions.filter((r) => r.status === 'open')).toHaveLength(0);
    const after = db.freeze(id);
    expect(after.status).toBe('pending_signature');
  });

  it('заморозка блокируется, пока есть открытые правки', () => {
    expect(() => db.freeze('c-6001')).toThrow(MockError);
  });

  it('отозвать/отклонить договор — терминально, без влияния на репутацию (только статус)', () => {
    const withdrawn = db.get('c-6003');
    expect(withdrawn.status).toBe('withdrawn_by_initiator');
    const rejected = db.get('c-6004');
    expect(rejected.status).toBe('rejected_by_counterparty');
  });

  it('вход из №5 «Отклонить на доработку» — коммент подписанта первой правкой', () => {
    const seeded = db.get('c-6005');
    const note = seeded.revisions.find((r) => r.item_ref === 'general:decline');
    expect(note).toBeDefined();
    expect(note?.status).toBe('open');
  });

  it('declineForRevision с комментарием создаёт правку и возвращает в under_review', () => {
    const id = 'c-3003'; // awaiting_signatures seed (DEV-05)
    const after = db.declineForRevision(id, 'contractor', 'Проверьте смету');
    expect(after.status).toBe('under_review');
    expect(after.revisions.some((r) => r.item_ref === 'general:decline' && r.after === 'Проверьте смету')).toBe(true);
  });
});
