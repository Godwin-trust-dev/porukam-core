import { describe, it, expect, beforeEach } from 'vitest';
import { db, MockError, resetContracts, resetPayouts } from '../src/mocks/contractsDb';

beforeEach(() => {
  resetContracts();
  resetPayouts();
});

/** Полный проход FSM согласования на мок-движке (зеркало §6.1). */
describe('Мок-FSM договора', () => {
  it('free_c2c: черновик → согласование → заморозка → две подписи → signed, без комиссии', () => {
    const c0 = db.list().find((c) => c.segment === 'free_c2c')!;
    const id = c0.id;
    db.send(id, 'customer');
    expect(db.get(id).status).toBe('under_review');
    db.freeze(id);
    expect(db.get(id).status).toBe('pending_signature');
    expect(db.get(id).version).not.toBeNull();
    db.requestSignature(id);
    db.markAiSummaryShown(id);
    db.sign(id, 'customer');
    expect(db.get(id).status).toBe('awaiting_signatures');
    db.sign(id, 'contractor');
    const signed = db.get(id);
    expect(signed.status).toBe('signed');
    expect(signed.contract_fee).toBeNull(); // комиссии на free_c2c нет
    expect(signed.signatures).toHaveLength(2);
  });

  it('paid_business: подписание не требует и не начисляет комиссию (финмодель v2)', () => {
    const c0 = db.list().find((c) => c.segment === 'paid_business')!;
    const id = c0.id;
    expect(db.get(id).total.amount).toBe('120000.00');
    db.send(id, 'customer');
    // requisites_missing до реквизитов выплат (не связано с комиссией — реквизиты для приёма платежей)
    expect(() => db.freeze(id)).toThrow(MockError);
    const acc = db.addPayoutAccount('sbp', '•••• 4321');
    db.setPayoutAccount(id, acc.id);
    db.freeze(id);
    db.requestSignature(id);
    db.markAiSummaryShown(id);
    db.sign(id, 'customer');
    db.sign(id, 'contractor');
    const signed = db.get(id);
    expect(signed.status).toBe('signed');
    expect(signed.contract_fee).toBeNull();
    expect(signed.payment_policy.contractFee.applies).toBe(false);
  });

  it('заморозку с открытой правкой отклоняет (422 open_revisions)', () => {
    const id = db.list().find((c) => c.segment === 'free_c2c')!.id;
    db.send(id, 'customer');
    db.proposeRevision(id, {
      author_role: 'contractor',
      item_ref: 'term:total',
      item_label: 'Сумма',
      before: '4000',
      after: '4500',
      comment: 'дороже',
      financially_material: true,
    });
    try {
      db.freeze(id);
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(MockError);
      expect((e as MockError).code).toBe('open_revisions');
    }
  });

  it('правка после заморозки возвращает в under_review и аннулирует подписи', () => {
    const id = db.list().find((c) => c.segment === 'free_c2c')!.id;
    db.send(id, 'customer');
    db.freeze(id);
    db.requestSignature(id);
    db.markAiSummaryShown(id);
    db.sign(id, 'customer');
    // Правка на этапе подписания → откат
    db.proposeRevision(id, {
      author_role: 'contractor',
      item_ref: 'term:note',
      item_label: 'Примечание',
      before: '',
      after: 'уточнение',
      comment: '',
      financially_material: false,
    });
    const c = db.get(id);
    expect(c.status).toBe('under_review');
    expect(c.version).toBeNull();
    expect(c.signatures).toHaveLength(0);
  });

  it('accept-all с финансово значимой правкой требует confirm_summary', () => {
    const id = db.list().find((c) => c.segment === 'free_c2c')!.id;
    db.send(id, 'customer');
    db.proposeRevision(id, {
      author_role: 'contractor',
      item_ref: 'term:total',
      item_label: 'Сумма',
      before: '4000',
      after: '4500',
      comment: '',
      financially_material: true,
    });
    expect(() => db.acceptAllRevisions(id, false)).toThrow(/подтверждения/);
    db.acceptAllRevisions(id, true);
    expect(db.get(id).revisions.every((r) => r.status === 'accepted')).toBe(true);
  });
});
