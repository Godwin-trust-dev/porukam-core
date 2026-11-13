import { describe, it, expect } from 'vitest';
import { computeContractFee, feeBreakdown } from '../src/billing';

const rub = (a: string) => ({ amount: a, currency: 'RUB' });

describe('computeContractFee (маржинальная шкала, ADR-054)', () => {
  it('контрольная точка задачи: 120 000 ₽ → 1 020 ₽', () => {
    expect(computeContractFee(rub('120000.00'), 'paid_business')).toEqual(rub('1020.00'));
  });

  it('free_c2c → null (ни слова о комиссии)', () => {
    expect(computeContractFee(rub('120000.00'), 'free_c2c')).toBeNull();
    expect(feeBreakdown(rub('120000.00'), 'free_c2c').fee).toBeNull();
  });

  it('paid_c2c тоже облагается', () => {
    expect(computeContractFee(rub('50000.00'), 'paid_c2c')).toEqual(rub('600.00'));
  });

  it('убывающая маржинальность: удвоение суммы не удваивает комиссию', () => {
    const fee1 = Number(computeContractFee(rub('100000.00'), 'paid_business')!.amount);
    const fee2 = Number(computeContractFee(rub('200000.00'), 'paid_business')!.amount);
    expect(fee2).toBeGreaterThan(fee1);
    expect(fee2).toBeLessThan(fee1 * 2);
  });

  it('нулевая/пустая сумма → 0', () => {
    expect(computeContractFee(rub('0.00'), 'paid_business')).toEqual(rub('0.00'));
  });
});
