import { describe, it, expect } from 'vitest';
import { BUNDLED_LOCALE_CODES, createI18n, loadLocaleResources, en, ru } from '@porukam/i18n';
import {
  PARENT_COMPANY_NAME,
  parentCompanyUrl,
} from '../src/shared/parentCompany';

/**
 * Подпись «Made by Trust Dev» в подвале публичного контура
 * (решение владельца 30.10.2026).
 *
 * Смысл тестов — не «переведено хорошо», а два правила, которые иначе
 * нарушатся молча: строка есть на всех 29 языках (без неё подвал покажет
 * сырой ключ `common.madeBy`), и имя компании подставляется, а не
 * переводится — то есть `{{brand}}` должен остаться в каждой локали.
 */

async function commonOf(code: string): Promise<Record<string, string>> {
  if (code === 'en') return en.common as Record<string, string>;
  if (code === 'ru') return ru.common as Record<string, string>;
  const i18n = createI18n('en');
  expect(await loadLocaleResources(i18n, code), code).toBe(true);
  const pack = i18n.getResourceBundle(code, 'translation') as {
    common: Record<string, string>;
  };
  return pack.common;
}

describe('Подпись автора продукта', () => {
  it('ключ common.madeBy есть на всех 29 языках и несёт плейсхолдер {{brand}}', async () => {
    expect(BUNDLED_LOCALE_CODES).toHaveLength(29);
    for (const code of BUNDLED_LOCALE_CODES) {
      const common = await commonOf(code);
      const phrase = common.madeBy;
      expect(typeof phrase, code).toBe('string');
      expect(phrase!.trim().length, code).toBeGreaterThan(0);
      // Имя собственное не переводится и не транслитерируется: если
      // плейсхолдер потерялся при правке перевода, в подвале останется
      // фраза без автора — то есть подпись без подписи.
      expect(phrase, code).toContain('{{brand}}');
      // И наоборот: вписанное руками имя вместо плейсхолдера разъедется
      // с константой при переименовании компании.
      expect(phrase, code).not.toContain(PARENT_COMPANY_NAME);
    }
  }, 30_000);

  it('русская страница ведёт на русскую версию, остальные 28 — на английскую', () => {
    expect(parentCompanyUrl('ru')).toBe('https://trust-dev.com/ru/');
    for (const code of BUNDLED_LOCALE_CODES.filter((c) => c !== 'ru')) {
      expect(parentCompanyUrl(code), code).toBe('https://trust-dev.com/');
    }
  });

  it('адрес — https и без лишнего пути (ссылка уходит с нашего домена)', () => {
    for (const code of BUNDLED_LOCALE_CODES) {
      const url = new URL(parentCompanyUrl(code));
      expect(url.protocol).toBe('https:');
      expect(url.hostname).toBe('trust-dev.com');
    }
  });
});
