/**
 * Мок-стор платежей по этапу (DEV-07) — отдельная от contractsDb проекция:
 * DEV-07 работает с фактом ПЕРЕВОДА по конкретному этапу, а не деревом Ф2.
 * Онлайн (СБП) — статус движется провайдером: мок держит `auto_succeed_at` и
 * доводит pending→succeeded «на чтении» (sweep-on-read, тот же приём, что и
 * доменные дедлайны §3 CLAUDE.md — не таймер в моке, а честная проверка времени).
 * Наличные — двустороннее подтверждение. Отметки необратимы: отмены нет,
 * расхождение уходит в спор (ADR-019/020), не откатывает состояние.
 */
import type { Payment, PaymentMethodKind, RevisionAuthorRole } from '@porukam/core';
import { db, MockError } from './contractsDb';

/** Внутреннее хранимое поле — момент, когда мок сам доведёт pending до succeeded. Не публичное. */
interface StoredPayment extends Payment {
  auto_succeed_at?: string;
}

let payments: StoredPayment[] = [];

const now = () => new Date().toISOString();
let seq = 9000;
const nid = (p: string) => `${p}-${++seq}`;

const DEMO_BANKS = ['Т-Банк', 'Сбербанк', 'Альфа-Банк'];
/** Ускоренный демо-таймер провайдера (секунды, не часы — §3 CLAUDE.md). */
const AUTO_SUCCEED_DELAY_MS = 3_000;

function findLeaf(contractId: string, titleContains: string) {
  const c = db.get(contractId);
  const m = c.milestones.find((x) => x.kind === 'leaf' && x.title.includes(titleContains));
  if (!m) throw new Error(`seed: этап «${titleContains}» не найден в ${contractId}`);
  return m;
}

function partyNames(contractId: string): { payer: string; payee: string } {
  const c = db.get(contractId);
  const customer = c.parties.find((p) => p.role === 'customer');
  const contractor = c.parties.find((p) => p.role === 'contractor');
  return { payer: customer?.display_name ?? '', payee: contractor?.display_name ?? '' };
}

function seed(): StoredPayment[] {
  const t = now();
  const list: StoredPayment[] = [];

  // (b) СБП online — pending, доведётся до succeeded при первом чтении спустя AUTO_SUCCEED_DELAY_MS.
  const stageOnline = findLeaf('c-5002', 'комната А');
  const namesB = partyNames('c-5002');
  list.push({
    id: 'pay-online-demo',
    contract_id: 'c-5002',
    stage_id: stageOnline.id,
    amount: stageOnline.amount!,
    method: 'sbp',
    status: 'pending',
    payer: { name: namesB.payer, confirmed: false },
    payee: { name: namesB.payee, confirmed: false },
    banks: DEMO_BANKS,
    created_at: t,
    auto_succeed_at: new Date(Date.now() + AUTO_SUCCEED_DELAY_MS).toISOString(),
  });

  // (c) Наличные — плательщик уже отметил, ждём получателя.
  const stageCash = findLeaf('c-5002', 'комната Б');
  list.push({
    id: 'pay-cash-demo',
    contract_id: 'c-5002',
    stage_id: stageCash.id,
    amount: stageCash.amount!,
    method: 'cash',
    status: 'awaiting_confirmation',
    payer: { name: namesB.payer, confirmed: true, at: t },
    payee: { name: namesB.payee, confirmed: false },
    created_at: t,
  });

  // (d) СБП — уже отказал, доступен повтор (новый платёж создаётся заново через /payments).
  const stageFailed = findLeaf('c-5002', 'комната В');
  list.push({
    id: 'pay-failed-demo',
    contract_id: 'c-5002',
    stage_id: stageFailed.id,
    amount: stageFailed.amount!,
    method: 'sbp',
    status: 'failed',
    payer: { name: namesB.payer, confirmed: false },
    payee: { name: namesB.payee, confirmed: false },
    banks: DEMO_BANKS,
    created_at: t,
  });

  return list;
}

export function resetPayments(): void {
  seq = 9000;
  payments = seed();
}

function toPublic(p: StoredPayment): Payment {
  const { auto_succeed_at: _auto_succeed_at, ...pub } = p;
  return pub;
}

/** Sweep-on-read: онлайн-платёж, которому пора «прийти» от провайдера, доводим до succeeded здесь. */
function settle(p: StoredPayment): StoredPayment {
  if (p.status === 'pending' && p.auto_succeed_at && Date.now() >= new Date(p.auto_succeed_at).getTime()) {
    p.status = 'succeeded';
    db.markStagePaid(p.contract_id, p.stage_id);
  }
  return p;
}

export const paymentsDb = {
  create(contractId: string, stageId: string, method: PaymentMethodKind, _role: RevisionAuthorRole): Payment {
    const c = db.get(contractId);
    const stage = c.milestones.find((m) => m.id === stageId);
    if (!stage || stage.kind !== 'leaf') throw new MockError(404, 'not_found', 'Этап не найден');
    if (stage.status !== 'accepted') {
      throw new MockError(409, 'invalid_state_transition', 'Этап ещё не принят — оплата недоступна');
    }
    const applicable = c.payment_policy.methods.some((m) => m.kind === method);
    if (!applicable) throw new MockError(422, 'method_not_available', 'Способ платежа недоступен в этой политике');
    const { payer, payee } = partyNames(contractId);

    const p: StoredPayment = {
      id: nid('pay'),
      contract_id: contractId,
      stage_id: stageId,
      amount: stage.amount!,
      method,
      status: method === 'sbp' ? 'pending' : 'awaiting_confirmation',
      payer: { name: payer, confirmed: false },
      payee: { name: payee, confirmed: false },
      banks: method === 'sbp' ? DEMO_BANKS : undefined,
      created_at: now(),
      auto_succeed_at: method === 'sbp' ? new Date(Date.now() + AUTO_SUCCEED_DELAY_MS).toISOString() : undefined,
    };
    payments.push(p);
    return toPublic(p);
  },

  get(pid: string): Payment {
    const p = payments.find((x) => x.id === pid);
    if (!p) throw new MockError(404, 'not_found', 'Платёж не найден');
    return toPublic(settle(p));
  },

  confirm(pid: string, by: 'payer' | 'payee'): Payment {
    const p = payments.find((x) => x.id === pid);
    if (!p) throw new MockError(404, 'not_found', 'Платёж не найден');
    if (p.status !== 'awaiting_confirmation') {
      throw new MockError(409, 'invalid_state_transition', 'Подтверждение доступно только для наличных в ожидании');
    }
    p[by] = { ...p[by], confirmed: true, at: now() };
    if (p.payer.confirmed && p.payee.confirmed) {
      p.status = 'confirmed';
      db.markStagePaid(p.contract_id, p.stage_id);
    }
    return toPublic(p);
  },

  /** Расхождение сторон — ведёт в спор (заглушка перехода, ADR-019/020); не откатывает отметки. */
  dispute(pid: string): Payment {
    const p = payments.find((x) => x.id === pid);
    if (!p) throw new MockError(404, 'not_found', 'Платёж не найден');
    p.status = 'disputed';
    return toPublic(p);
  },
};

resetPayments();
