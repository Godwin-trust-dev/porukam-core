import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { paymentsDb, resetPayments } from '../src/mocks/paymentsDb';
import { db, MockError, resetContracts } from '../src/mocks/contractsDb';

beforeEach(() => {
  resetContracts();
  resetPayments();
});
afterEach(() => {
  vi.useRealTimers();
});

/** DEV-07 §6/§8 — движок мока платежей, зеркало сквозных сценариев экрана. */
describe('Мок-движок платежей (DEV-07)', () => {
  it('(a) создание СБП-платежа для due-этапа → pending, лист остаётся accepted', () => {
    const c = db.get('c-5001');
    const stage = c.milestones.find((m) => m.kind === 'leaf' && m.status === 'accepted')!;
    const p = paymentsDb.create('c-5001', stage.id, 'sbp', 'customer');
    expect(p.status).toBe('pending');
    expect(db.get('c-5001').milestones.find((m) => m.id === stage.id)!.status).toBe('accepted');
  });

  it('нельзя создать платёж для этапа не в состоянии accepted (waiting_gate → 409)', () => {
    const c = db.get('c-5001');
    const notYet = c.milestones.find((m) => m.kind === 'leaf' && m.status === 'waiting_gate')!;
    expect(() => paymentsDb.create('c-5001', notYet.id, 'sbp', 'customer')).toThrow(MockError);
  });

  it('нельзя создать платёж способом, которого нет в paymentPolicy.methods (NO_PROVIDER → sbp запрещён)', () => {
    const c = db.get('c-5005');
    const stage = c.milestones.find((m) => m.kind === 'leaf')!;
    expect(() => paymentsDb.create('c-5005', stage.id, 'sbp', 'customer')).toThrow(MockError);
    expect(() => paymentsDb.create('c-5005', stage.id, 'cash', 'customer')).not.toThrow();
  });

  it('sweep-on-read: pending СБП доводится до succeeded по времени, лист становится paid', () => {
    vi.useFakeTimers();
    const c = db.get('c-5001');
    const stage = c.milestones.find((m) => m.kind === 'leaf' && m.status === 'accepted')!;
    const p = paymentsDb.create('c-5001', stage.id, 'sbp', 'customer');
    expect(paymentsDb.get(p.id).status).toBe('pending');

    vi.advanceTimersByTime(3_100);
    const settled = paymentsDb.get(p.id);
    expect(settled.status).toBe('succeeded');
    expect(db.get('c-5001').milestones.find((m) => m.id === stage.id)!.status).toBe('paid');
  });

  it('наличные: подтверждение обеих сторон → confirmed, лист становится paid; одной стороны — не хватает', () => {
    const c = db.get('c-5001');
    const stage = c.milestones.find((m) => m.kind === 'leaf' && m.status === 'accepted')!;
    const p = paymentsDb.create('c-5001', stage.id, 'cash', 'customer');
    expect(p.status).toBe('awaiting_confirmation');

    const afterPayer = paymentsDb.confirm(p.id, 'payer');
    expect(afterPayer.status).toBe('awaiting_confirmation');
    expect(db.get('c-5001').milestones.find((m) => m.id === stage.id)!.status).toBe('accepted');

    const afterBoth = paymentsDb.confirm(p.id, 'payee');
    expect(afterBoth.status).toBe('confirmed');
    expect(db.get('c-5001').milestones.find((m) => m.id === stage.id)!.status).toBe('paid');
  });

  it('расхождение → dispute переводит платёж в disputed, не откатывает подтверждения', () => {
    const c = db.get('c-5001');
    const stage = c.milestones.find((m) => m.kind === 'leaf' && m.status === 'accepted')!;
    const p = paymentsDb.create('c-5001', stage.id, 'cash', 'customer');
    paymentsDb.confirm(p.id, 'payer');
    const disputed = paymentsDb.dispute(p.id);
    expect(disputed.status).toBe('disputed');
    expect(disputed.payer.confirmed).toBe(true);
  });

  it('сид (b)/(c)/(d): pending/awaiting_confirmation/failed присутствуют на c-5002', () => {
    expect(paymentsDb.get('pay-online-demo').status).toBe('pending');
    expect(paymentsDb.get('pay-cash-demo').status).toBe('awaiting_confirmation');
    expect(paymentsDb.get('pay-failed-demo').status).toBe('failed');
  });
});
