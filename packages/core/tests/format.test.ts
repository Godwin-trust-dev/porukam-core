import { describe, it, expect } from 'vitest';
import {
  formatMoney,
  formatPolicyMoney,
  formatDate,
  formatShortDate,
  formatDateTime,
  formatCountdown,
  formatFileSize,
  setDefaultFormatTimeZone,
} from '../src/format';
import { previewSegment, hasContractFee } from '../src/segment';

describe('formatMoney', () => {
  it('форматирует целую сумму с символом валюты', () => {
    const s = formatMoney({ amount: '15000.00', currency: 'RUB' });
    expect(s).toContain('₽');
    expect(s.replace(/\s| | /g, '')).toBe('15000₽');
  });

  it('неизвестную валюту печатает кодом', () => {
    expect(formatMoney({ amount: '10.00', currency: 'XYZ' })).toContain('XYZ');
  });
});

// DEV-16 §5 (обновлено 10.08, связано с LTR-островками DEV-16c §2): восточно-арабские/
// персидские цифры — вне ASCII 0-9, ловим их явно.
const NON_LATIN_DIGITS = /[٠-٩۰-۹]/;

describe('formatMoney — юрзначимая сумма латиницей во всех локалях (DEV-16 §5)', () => {
  it('в ar-SA цифры остаются латинскими (numberingSystem: latn), а не восточно-арабскими', () => {
    const s = formatMoney({ amount: '15000.00', currency: 'RUB' }, 'ar-SA');
    expect(s).not.toMatch(NON_LATIN_DIGITS);
    expect(s).toMatch(/15,?\s?000/);
  });

  it('в fa-IR цифры остаются латинскими', () => {
    const s = formatMoney({ amount: '15000.00', currency: 'RUB' }, 'fa-IR');
    expect(s).not.toMatch(NON_LATIN_DIGITS);
  });

  it('цифровая часть суммы совпадает в en-US и ar-SA — сумма договора одинакова у обеих сторон', () => {
    const en = formatMoney({ amount: '15000.00', currency: 'RUB' }, 'en-US');
    const ar = formatMoney({ amount: '15000.00', currency: 'RUB' }, 'ar-SA');
    expect(ar.match(/\d+/g)).toEqual(en.match(/\d+/g));
  });
});

describe('formatDate/formatDateTime — { legal: true } → latn (DEV-16 §5, юрзначимые даты)', () => {
  it('без опции — обычная (неюридическая) дата в ar-SA восточно-арабскими цифрами', () => {
    const s = formatDate('2026-08-11T00:00:00Z', 'ar-SA');
    expect(s).toMatch(NON_LATIN_DIGITS);
  });

  it('{ legal: true } — срок договора/дата подписания в ar-SA остаётся латиницей', () => {
    const s = formatDate('2026-08-11T00:00:00Z', 'ar-SA', undefined, { legal: true });
    expect(s).not.toMatch(NON_LATIN_DIGITS);
  });

  it('{ legal: true } — совпадают цифры (день/год) юрдаты в en-US и ar-SA', () => {
    const en = formatDate('2026-08-11T00:00:00Z', 'en-US', undefined, { legal: true });
    const ar = formatDate('2026-08-11T00:00:00Z', 'ar-SA', undefined, { legal: true });
    expect(ar.match(/\d+/g)).toEqual(en.match(/\d+/g));
  });

  it('formatDateTime { legal: true } (TSA-время/дата подписания) — латиница в fa-IR', () => {
    const s = formatDateTime('2026-08-11T10:30:00Z', 'fa-IR', undefined, { legal: true });
    expect(s).not.toMatch(NON_LATIN_DIGITS);
  });
});

describe('formatShortDate — короткая дата списков (замечание владельца 03.09, доска A)', () => {
  const NOW = Date.parse('2026-09-03T12:00:00Z');

  it('тот же год — день и сокращённый месяц, без года', () => {
    const s = formatShortDate('2026-09-03T09:00:00Z', 'ru-RU', 'Europe/Moscow', NOW);
    expect(s).toContain('3');
    expect(s).toMatch(/сен/);
    expect(s).not.toContain('2026');
  });

  it('другой год — год печатается', () => {
    const s = formatShortDate('2025-09-03T09:00:00Z', 'ru-RU', 'Europe/Moscow', NOW);
    expect(s).toContain('2025');
    expect(s).toMatch(/сен/);
  });

  it('месяц берётся у Intl — в en-US это «Sep», не русское сокращение', () => {
    expect(formatShortDate('2026-09-03T09:00:00Z', 'en-US', 'Europe/Moscow', NOW)).toMatch(/Sep/);
  });

  it('год сравнивается в поясе отображения: 31 декабря по Москве — тот же год, что «сейчас»', () => {
    // 2026-12-31T22:00Z = 2027-01-01 01:00 по Москве → в поясе показа это уже 2027,
    // а «сейчас» (2027-06 по Москве) — тоже 2027, года быть не должно.
    const now = Date.parse('2027-06-01T00:00:00Z');
    expect(formatShortDate('2026-12-31T22:00:00Z', 'ru-RU', 'Europe/Moscow', now)).not.toContain('2026');
  });

  it('битую строку отдаёт как есть (как остальные форматтеры)', () => {
    expect(formatShortDate('не-дата', 'ru-RU', 'Europe/Moscow', NOW)).toBe('не-дата');
  });

  it('полная дата остаётся длинной — короткий формат её не подменяет', () => {
    const long = formatDate('2026-09-03T09:00:00Z', 'ru-RU', 'Europe/Moscow');
    expect(long).toContain('2026');
    expect(long).not.toBe(formatShortDate('2026-09-03T09:00:00Z', 'ru-RU', 'Europe/Moscow', NOW));
  });
});

describe('часовой пояс отображения', () => {
  it('дата и время считаются в переданном поясе, а не в московском', () => {
    // 20:00 UTC — в Москве ещё 11-е (23:00), в Джакарте уже 12-е (03:00).
    expect(formatDateTime('2026-08-11T20:00:00Z', 'en-US', 'Europe/Moscow')).toContain('Aug 11');
    expect(formatDateTime('2026-08-11T20:00:00Z', 'en-US', 'Asia/Jakarta')).toContain('Aug 12');
  });

  it('setDefaultFormatTimeZone меняет пояс по умолчанию для вызовов без аргумента', () => {
    setDefaultFormatTimeZone('Asia/Jakarta');
    try {
      expect(formatDateTime('2026-08-11T20:00:00Z', 'en-US')).toContain('Aug 12');
    } finally {
      setDefaultFormatTimeZone('Europe/Moscow');
    }
  });

  it('юрзначимое время печатается с меткой пояса — момент однозначен для обеих сторон', () => {
    // Без метки «12:00» у сторон в разных поясах — это два разных момента.
    const s = formatDateTime('2026-08-11T10:30:00Z', 'en-US', 'Asia/Jakarta', { legal: true });
    expect(s).toMatch(/GMT|UTC/);
    expect(formatDateTime('2026-08-11T10:30:00Z', 'en-US', 'Asia/Jakarta')).not.toMatch(/GMT|UTC/);
  });
});

describe('formatPolicyMoney (DEV-05-PATCH, ADR-032) — символ/decimals из paymentPolicy.currency', () => {
  it('не-RUB валюта: символ и точность берутся из переданной политики, не из встроенного маппинга', () => {
    const s = formatPolicyMoney({ amount: '90.00', currency: 'USD' }, { code: 'USD', symbol: '$', decimals: 2 });
    expect(s).toBe('90 $');
  });

  it('дробная сумма форматируется с decimals из политики', () => {
    const s = formatPolicyMoney({ amount: '90.50', currency: 'USD' }, { code: 'USD', symbol: '$', decimals: 2 });
    expect(s).toBe('90,50 $');
  });
});

describe('formatCountdown', () => {
  it('показывает часы и минуты', () => {
    const now = 0;
    const deadline = new Date(now + (2 * 3600 + 30 * 60) * 1000).toISOString();
    expect(formatCountdown(deadline, now)).toBe('2 ч 30 мин');
  });
  it('не уходит в минус после дедлайна', () => {
    expect(formatCountdown(new Date(0).toISOString(), 10_000)).toBe('0 мин');
  });
});

describe('formatFileSize (DEV-12) — Б/КБ/МБ/ГБ', () => {
  it('меньше 1 КБ печатает в байтах', () => {
    expect(formatFileSize(512)).toBe('512 Б');
  });
  it('переходит в МБ с одним знаком после запятой', () => {
    expect(formatFileSize(4_400_000)).toBe('4,2 МБ');
  });
  it('переходит в ГБ', () => {
    expect(formatFileSize(2 * 1024 ** 3)).toBe('2 ГБ');
  });
});

describe('previewSegment (зеркало для UX, не истина)', () => {
  it('оба физлица без оплаты → free_c2c (без комиссии)', () => {
    const seg = previewSegment({ customerKind: 'person', contractorKind: 'person', isPaid: false });
    expect(seg).toBe('free_c2c');
    expect(hasContractFee(seg)).toBe(false);
  });
  it('участник-бизнес → paid_business (комиссия есть)', () => {
    const seg = previewSegment({ customerKind: 'business', contractorKind: 'person', isPaid: true });
    expect(seg).toBe('paid_business');
    expect(hasContractFee(seg)).toBe(true);
  });
});
