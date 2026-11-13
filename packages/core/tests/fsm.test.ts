import { describe, it, expect } from 'vitest';
import { canTransition, isEditable, isTerminal, canTransitionExecution, computeCardStatus } from '../src/fsm';

describe('FSM согласования (§6.1)', () => {
  it('разрешённые переходы', () => {
    expect(canTransition('draft', 'under_review')).toBe(true);
    expect(canTransition('under_review', 'pending_signature')).toBe(true);
    expect(canTransition('pending_signature', 'awaiting_signatures')).toBe(true);
    expect(canTransition('awaiting_signatures', 'signed')).toBe(true);
    // Правка после заморозки возвращает в under_review.
    expect(canTransition('pending_signature', 'under_review')).toBe(true);
    expect(canTransition('awaiting_signatures', 'under_review')).toBe(true);
  });

  it('запрещённые переходы', () => {
    expect(canTransition('draft', 'signed')).toBe(false);
    expect(canTransition('draft', 'pending_signature')).toBe(false);
    expect(canTransition('signed', 'under_review')).toBe(false);
    expect(canTransition('under_review', 'signed')).toBe(false);
  });

  it('терминальные статусы', () => {
    expect(isTerminal('signed')).toBe(true);
    expect(isTerminal('rejected_by_counterparty')).toBe(true);
    expect(isTerminal('under_review')).toBe(false);
  });

  it('правки только в draft/under_review', () => {
    expect(isEditable('draft')).toBe(true);
    expect(isEditable('under_review')).toBe(true);
    expect(isEditable('pending_signature')).toBe(false);
    expect(isEditable('signed')).toBe(false);
  });
});

describe('FSM исполнения (§6.2, DEV-06)', () => {
  it('разрешённые переходы исполнения', () => {
    expect(canTransitionExecution('in_progress', 'completed')).toBe(true);
    expect(canTransitionExecution('in_progress', 'terminated_by_customer')).toBe(true);
    expect(canTransitionExecution('in_progress', 'terminated_by_contractor')).toBe(true);
    expect(canTransitionExecution('completed', 'under_warranty')).toBe(true);
    expect(canTransitionExecution('under_warranty', 'warranty_claim')).toBe(true);
  });

  it('запрещённые переходы исполнения', () => {
    expect(canTransitionExecution('completed', 'in_progress')).toBe(false);
    expect(canTransitionExecution('terminated_by_customer', 'in_progress')).toBe(false);
    expect(canTransitionExecution('under_warranty', 'completed')).toBe(false);
  });

  it('computeCardStatus: без исполнения — статус согласования как есть', () => {
    expect(computeCardStatus({ status: 'signed' })).toBe('signed');
    expect(computeCardStatus({ status: 'draft' })).toBe('draft');
  });

  it('computeCardStatus: исполнение переопределяет статус согласования', () => {
    expect(computeCardStatus({ status: 'signed', execution: 'in_progress' })).toBe('in_progress');
    expect(computeCardStatus({ status: 'signed', execution: 'completed' })).toBe('completed');
    expect(computeCardStatus({ status: 'signed', execution: 'terminated_by_customer' })).toBe(
      'terminated_by_customer',
    );
  });

  it('computeCardStatus: suspended — вычисляемый, только in_progress + приостановленный этап', () => {
    expect(computeCardStatus({ status: 'signed', execution: 'in_progress', hasSuspendedStage: true })).toBe(
      'suspended',
    );
    expect(computeCardStatus({ status: 'signed', execution: 'in_progress', hasSuspendedStage: false })).toBe(
      'in_progress',
    );
    // completed + приостановленный этап невозможен по FSM, но suspended не должен «протекать» дальше in_progress.
    expect(computeCardStatus({ status: 'signed', execution: 'completed', hasSuspendedStage: true })).toBe(
      'completed',
    );
  });
});
