/**
 * Money — деньги на фронте (ТЗ §9.2, ADR-041).
 *
 * Инварианты:
 *  - валюты по умолчанию НЕТ нигде: currency обязателен;
 *  - сумма хранится строкой (без потери точности), как в API
 *    ({"amount":"15000.00","currency":"RUB"});
 *  - складывать/вычитать можно только одинаковые валюты — иначе ошибка
 *    на этапе разработки (баг, а не тихая порча данных).
 *
 * Арифметика — на BigInt по минорным единицам (scale=2 достаточно для RUB;
 * при иной точности значений — берём максимум дробных знаков операндов).
 */
export interface MoneyLike {
  amount: string;
  currency: string;
}

export class Money implements MoneyLike {
  readonly amount: string;
  readonly currency: string;

  private constructor(amount: string, currency: string) {
    this.amount = amount;
    this.currency = currency;
  }

  static of(amount: string, currency: string): Money {
    if (currency == null || currency.trim() === '') {
      throw new Error('Money: валюта обязательна — валюты по умолчанию нет (ADR-041)');
    }
    if (!/^-?\d+(\.\d+)?$/.test(amount)) {
      throw new Error(`Money: некорректная сумма «${amount}»`);
    }
    return new Money(amount, currency);
  }

  static from(m: MoneyLike): Money {
    return Money.of(m.amount, m.currency);
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new Error(
        `Money: нельзя складывать разные валюты (${this.currency} и ${other.currency})`,
      );
    }
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(decimalOp(this.amount, other.amount, 'add'), this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(decimalOp(this.amount, other.amount, 'sub'), this.currency);
  }

  isZero(): boolean {
    return /^-?0(\.0+)?$/.test(this.amount);
  }

  isNegative(): boolean {
    return this.amount.startsWith('-') && !this.isZero();
  }

  toJSON(): MoneyLike {
    return { amount: this.amount, currency: this.currency };
  }
}

function scaleOf(s: string): number {
  const i = s.indexOf('.');
  return i === -1 ? 0 : s.length - i - 1;
}

/** Точная десятичная операция над строками через BigInt. */
function decimalOp(a: string, b: string, op: 'add' | 'sub'): string {
  const scale = Math.max(scaleOf(a), scaleOf(b));
  const toScaled = (s: string): bigint => {
    const neg = s.startsWith('-');
    const abs = neg ? s.slice(1) : s;
    const [int, frac = ''] = abs.split('.');
    const padded = (int + frac.padEnd(scale, '0')).replace(/^0+(?=\d)/, '');
    const v = BigInt(padded || '0');
    return neg ? -v : v;
  };
  const res = op === 'add' ? toScaled(a) + toScaled(b) : toScaled(a) - toScaled(b);
  const neg = res < 0n;
  let digits = (neg ? -res : res).toString().padStart(scale + 1, '0');
  if (scale === 0) return (neg ? '-' : '') + digits;
  const int = digits.slice(0, digits.length - scale);
  const frac = digits.slice(digits.length - scale);
  return (neg ? '-' : '') + int + '.' + frac;
}
