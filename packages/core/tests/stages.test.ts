import { describe, it, expect } from 'vitest';
import { distributeEvenly, sumMoney, percentOfMoney, percentFromMoney } from '../src/stages';

describe('distributeEvenly (DEV-09 §4.2)', () => {
  it('делит поровну, если делится без остатка', () => {
    const parts = distributeEvenly({ amount: '3000.00', currency: 'RUB' }, 3);
    expect(parts).toEqual([
      { amount: '1000.00', currency: 'RUB' },
      { amount: '1000.00', currency: 'RUB' },
      { amount: '1000.00', currency: 'RUB' },
    ]);
  });

  it('остаток от округления уходит в последний этап', () => {
    const parts = distributeEvenly({ amount: '100.00', currency: 'RUB' }, 3);
    expect(parts.map((p) => p.amount)).toEqual(['33.33', '33.33', '33.34']);
    const sum = sumMoney(parts, 'RUB');
    expect(sum.amount).toBe('100.00');
  });

  it('n=1 отдаёт всю сумму одним этапом', () => {
    expect(distributeEvenly({ amount: '4500.00', currency: 'RUB' }, 1)).toEqual([{ amount: '4500.00', currency: 'RUB' }]);
  });

  it('n<=0 возвращает пустой список', () => {
    expect(distributeEvenly({ amount: '100.00', currency: 'RUB' }, 0)).toEqual([]);
  });

  it('сумма частей всегда точно равна total (property-подобная проверка на наборе сумм)', () => {
    for (const amount of ['10.01', '999.99', '7.00', '123456.78']) {
      for (const n of [2, 3, 4, 5, 7]) {
        const parts = distributeEvenly({ amount, currency: 'RUB' }, n);
        expect(sumMoney(parts, 'RUB').amount).toBe(Number(amount).toFixed(2));
      }
    }
  });
});

describe('sumMoney', () => {
  it('суммирует список без потери точности', () => {
    const sum = sumMoney(
      [
        { amount: '10.10', currency: 'RUB' },
        { amount: '0.05', currency: 'RUB' },
      ],
      'RUB',
    );
    expect(sum.amount).toBe('10.15');
  });

  it('пустой список даёт 0.00', () => {
    expect(sumMoney([], 'RUB').amount).toBe('0.00');
  });
});

describe('percentOfMoney / percentFromMoney (DEV-09 §4.4, PaymentModal)', () => {
  it('аванс 30% от 20000 = 6000', () => {
    const advance = percentOfMoney({ amount: '20000.00', currency: 'RUB' }, 30);
    expect(advance).toEqual({ amount: '6000.00', currency: 'RUB' });
  });

  it('после приёмки = сумма − аванс', () => {
    const total = { amount: '20000.00', currency: 'RUB' };
    const advance = percentOfMoney(total, 30);
    expect((Number(total.amount) - Number(advance.amount)).toFixed(2)).toBe('14000.00');
  });

  it('обратное преобразование суммы в проценты', () => {
    expect(percentFromMoney({ amount: '20000.00', currency: 'RUB' }, { amount: '6000.00', currency: 'RUB' })).toBe(30);
  });

  it('двусторонняя конвертация даёт исходную сумму', () => {
    const total = { amount: '15000.00', currency: 'RUB' };
    const pct = percentFromMoney(total, { amount: '4500.00', currency: 'RUB' });
    expect(percentOfMoney(total, pct).amount).toBe('4500.00');
  });

  it('total = 0 не делит на ноль', () => {
    expect(percentFromMoney({ amount: '0.00', currency: 'RUB' }, { amount: '0.00', currency: 'RUB' })).toBe(0);
  });
});
