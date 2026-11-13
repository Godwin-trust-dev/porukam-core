/**
 * Нечёткий поиск по каталожным справочникам (сферы, DEV-09 §3) — зеркало
 * серверных правил `backend/apps/catalog/search.py` (ADR-097) для мок-режима:
 * MSW обязан вести себя как Django, иначе e2e проверяют не то, что увидит
 * пользователь real-режима.
 *
 * Правила: нормализация (нижний регистр, ё→е, пунктуация → пробел),
 * по-токенно: точное слово > префикс > подстрока (от 3 символов) > опечатка
 * (Дамерау-Левенштейн, допуск от длины токена: до 3 — 0, 4–7 — 1, от 8 — 2);
 * достаточно одного совпавшего токена запроса, больше совпало — выше;
 * фразовый бонус за вхождение запроса в имя целиком.
 */

const TYPO_1_MIN_LEN = 4;
const TYPO_2_MIN_LEN = 8;
const SUBSTRING_MIN_LEN = 3;

const SCORE_EXACT = 100;
const SCORE_PREFIX = 85;
const SCORE_SUBSTRING = 65;
const SCORE_TYPO_BASE = 60;

const PHRASE_BONUS = 200;

export function normalizeSearchText(text: string): string {
  return text
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function tokenize(text: string): string[] {
  const normalized = normalizeSearchText(text);
  return normalized ? normalized.split(' ') : [];
}

/** Расстояние Дамерау-Левенштейна с отсечкой: больше cutoff → cutoff + 1. */
export function damerauLevenshtein(a: string, b: string, cutoff: number): number {
  if (Math.abs(a.length - b.length) > cutoff) return cutoff + 1;
  let prevPrev: number[] = [];
  let prev: number[] = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i += 1) {
    const current: number[] = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a.charAt(i - 1) === b.charAt(j - 1) ? 0 : 1;
      let value = Math.min((prev[j] ?? 0) + 1, (current[j - 1] ?? 0) + 1, (prev[j - 1] ?? 0) + cost);
      if (i > 1 && j > 1 && a.charAt(i - 1) === b.charAt(j - 2) && a.charAt(i - 2) === b.charAt(j - 1)) {
        value = Math.min(value, (prevPrev[j - 2] ?? 0) + 1);
      }
      current.push(value);
    }
    prevPrev = prev;
    prev = current;
    if (Math.min(...prev) > cutoff) return cutoff + 1;
  }
  return prev[b.length] ?? cutoff + 1;
}

function maxTypos(tokenLen: number): number {
  if (tokenLen >= TYPO_2_MIN_LEN) return 2;
  if (tokenLen >= TYPO_1_MIN_LEN) return 1;
  return 0;
}

function tokenScore(queryToken: string, word: string): number {
  if (queryToken === word) return SCORE_EXACT;
  if (word.startsWith(queryToken)) return SCORE_PREFIX;
  if (queryToken.length >= SUBSTRING_MIN_LEN && word.includes(queryToken)) return SCORE_SUBSTRING;
  const allowed = maxTypos(queryToken.length);
  if (allowed > 0) {
    const distance = damerauLevenshtein(queryToken, word, allowed);
    if (distance <= allowed) return SCORE_TYPO_BASE - 10 * distance;
  }
  return 0;
}

/**
 * Ранжированный нечёткий поиск по элементам с именем. Пустой запрос —
 * все элементы как есть (показ полного списка — решение вызывающей
 * стороны, у сервера то же поведение без `q`).
 */
export function searchCatalog<T extends { name: string }>(query: string, items: T[]): T[] {
  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) return items;

  const normalizedQuery = normalizeSearchText(query);
  const ranked: { matched: number; total: number; index: number; item: T }[] = [];
  items.forEach((item, index) => {
    const words = tokenize(item.name);
    let matched = 0;
    let total = 0;
    for (const token of queryTokens) {
      const best = Math.max(0, ...words.map((word) => tokenScore(token, word)));
      if (best > 0) {
        matched += 1;
        total += best;
      }
    }
    if (matched === 0) return;
    if (normalizeSearchText(item.name).includes(normalizedQuery)) total += PHRASE_BONUS;
    ranked.push({ matched, total, index, item });
  });

  ranked.sort((a, b) => b.matched - a.matched || b.total - a.total || a.index - b.index);
  return ranked.map((r) => r.item);
}
