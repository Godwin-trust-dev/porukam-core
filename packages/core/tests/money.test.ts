import { describe, it, expect } from 'vitest';
import { Money } from '../src/money';

describe('Money', () => {
  it('требует валюту — валюты по умолчанию нет (ADR-041)', () => {
    expect(() => Money.of('100.00', '')).toThrow(/валюта обязательна/);
    // @ts-expect-error проверка рантайма при отсутствии валюты
    expect(() => Money.of('100.00', undefined)).toThrow();
  });

  it('не складывает разные валюты', () => {
    const rub = Money.of('100.00', 'RUB');
    const usd = Money.of('100.00', 'USD');
    expect(() => rub.add(usd)).toThrow(/разные валюты/);
    expect(() => rub.subtract(usd)).toThrow(/разные валюты/);
  });

  it('складывает одинаковые валюты без потери точности', () => {
    const a = Money.of('15000.50', 'RUB');
    const b = Money.of('2499.50', 'RUB');
    expect(a.add(b).amount).toBe('17500.00');
    expect(a.add(b).currency).toBe('RUB');
  });

  it('корректно вычитает и различает знак/ноль', () => {
    const a = Money.of('100.00', 'RUB');
    const b = Money.of('100.00', 'RUB');
    expect(a.subtract(b).isZero()).toBe(true);
    const c = Money.of('40.00', 'RUB');
    expect(c.subtract(a).isNegative()).toBe(true);
    expect(c.subtract(a).amount).toBe('-60.00');
  });

  it('сериализуется как API-объект {amount, currency}', () => {
    expect(Money.of('15000.00', 'RUB').toJSON()).toEqual({ amount: '15000.00', currency: 'RUB' });
  });

  it('отклоняет некорректную сумму', () => {
    expect(() => Money.of('12,50', 'RUB')).toThrow();
    expect(() => Money.of('abc', 'RUB')).toThrow();
  });
});
