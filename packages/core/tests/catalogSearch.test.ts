import { describe, expect, it } from 'vitest';
import { damerauLevenshtein, normalizeSearchText, searchCatalog } from '../src/catalogSearch';

// Зеркало кейсов backend/apps/catalog/tests/test_search.py (ADR-097):
// мок-режим обязан вести себя как Django.

const SPHERES = [
  { code: 'repair', name: 'Ремонт' },
  { code: 'finishing', name: 'Отделочные работы' },
  { code: 'furniture', name: 'Сборка мебели' },
  { code: 'cleaning', name: 'Уборка' },
];

describe('normalizeSearchText', () => {
  it('нижний регистр, ё→е, пунктуация → пробел', () => {
    expect(normalizeSearchText('Съёмка, монтаж!')).toBe('съемка монтаж');
  });
});

describe('damerauLevenshtein', () => {
  it('замена и перестановка соседей стоят 1', () => {
    expect(damerauLevenshtein('римонт', 'ремонт', 2)).toBe(1);
    expect(damerauLevenshtein('рмеонт', 'ремонт', 2)).toBe(1);
  });
  it('отсечка ограничивает результат', () => {
    expect(damerauLevenshtein('плитка', 'водоснабжение', 2)).toBe(3);
  });
});

describe('searchCatalog', () => {
  it('пустой запрос — все элементы как есть', () => {
    expect(searchCatalog('', SPHERES)).toEqual(SPHERES);
  });

  it('префикс находит сферу', () => {
    expect(searchCatalog('рем', SPHERES).map((s) => s.code)).toEqual(['repair']);
  });

  it('опечатка не даёт пустоту', () => {
    expect(searchCatalog('римонт', SPHERES).map((s) => s.code)).toEqual(['repair']);
  });

  it('лишнее слово не убивает совпадение (запрос из плейсхолдера UI)', () => {
    expect(searchCatalog('ремонт кухни', SPHERES).map((s) => s.code)).toContain('repair');
  });

  it('полное имя ранжируется первым', () => {
    const items = [...SPHERES, { code: 'x', name: 'Ремонт техники' }];
    expect(searchCatalog('ремонт техники', items)[0]?.code).toBe('x');
  });

  it('двухбуквенный токен — не подстрочное совпадение', () => {
    expect(searchCatalog('zz-no-such', [{ code: 'r', name: 'Renovation' }])).toEqual([]);
  });

  it('нет совпадений — пустой список, не ошибка', () => {
    expect(searchCatalog('чебурашка', SPHERES)).toEqual([]);
  });
});
