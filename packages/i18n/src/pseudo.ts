/**
 * Псевдолокаль (DEV-16 §1 ⭐ — «вёрстка не ломается на псевдолокали с длинными строками,
 * en-XA-подобный тест»). Берёт EN-пакет и оборачивает каждую строку в скобки + расширяет
 * длину на ~35% диакритикой — тот же принцип, что промышленный `en-XA` (Qt/ICU): длина
 * растёт (типичный перевод длиннее английского), но текст остаётся читаемым латиницей,
 * а границы `[…]` сразу видны при обрезании/переполнении контейнера.
 * `{{interpolation}}`-токены и цифры/пунктуация — не трогаем (иначе i18next не подставит
 * значения и тест даст ложный результат).
 */
const ACCENT_MAP: Record<string, string> = {
  a: 'à', e: 'é', i: 'ì', o: 'ò', u: 'ù', y: 'ý',
  A: 'À', E: 'É', I: 'Ì', O: 'Ò', U: 'Ù', Y: 'Ý',
};

function accentize(word: string): string {
  return word.replace(/[a-zA-Z]/g, (ch) => ACCENT_MAP[ch] ?? ch);
}

/** Расширить строку на `ratio` (по умолчанию ~35%) добавлением диакритического «жира» в конце. */
function pad(text: string, ratio = 0.35): string {
  const extra = Math.ceil(text.length * ratio);
  const filler = accentize('lorem ipsum dolor sit amet consectetur'.slice(0, extra));
  return filler ? `${text} ${filler}` : text;
}

function pseudoizeString(s: string): string {
  // {{var}}-токены оставляем как есть — подставляются i18next, не текст для отображения.
  const parts = s.split(/(\{\{[^}]+\}\})/g);
  const transformed = parts
    .map((part) => (part.startsWith('{{') ? part : accentize(part)))
    .join('');
  return `[${pad(transformed)}]`;
}

export function pseudoize<T>(dict: T): T {
  if (typeof dict === 'string') return pseudoizeString(dict) as unknown as T;
  if (Array.isArray(dict)) return dict.map((v) => pseudoize(v)) as unknown as T;
  if (dict && typeof dict === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(dict as Record<string, unknown>)) out[k] = pseudoize(v);
    return out as T;
  }
  return dict;
}
