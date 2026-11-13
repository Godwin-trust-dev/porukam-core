#!/usr/bin/env node
/**
 * Линтер bidi-изоляции в RTL-локалях.
 *
 * По алгоритму Unicode Bidi (UAX #9) латинское слово рядом с числом внутри
 * арабского/ивритского абзаца образует ОДИН слабый ран, и его части
 * переставляются: «iPhone 13 128 GB» читается на экране как «GB 128 13 iPhone»,
 * «Bosch GBH 2-26» — как «2-26 Bosch GBH». Лечится изолятами U+2066 (LRI) …
 * U+2069 (PDI): содержимое печатается слева направо целиком.
 *
 * `LtrText` в packages/ui закрывает только рендер компонентов; плейсхолдеры
 * полей — это HTML-атрибут, JSX туда не вставить, поэтому изоляты живут прямо
 * в строках локали. Этот линтер не даёт им пропасть при следующих правках.
 *
 * Запуск: node scripts/lint-bidi.mjs
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const LOCALES_DIR = join(ROOT, 'packages/i18n/src/locales');
const RTL_LOCALES = ['ar', 'fa', 'he', 'ur'];

const LRI = '⁦';
const PDI = '⁩';

/** Латиница, за которой через пробел идут цифры (или наоборот) — рискованный ран. */
const RISKY = /[A-Za-z][A-Za-z./-]*(?:[  ][0-9A-Za-z./-]+)+/g;

const flatten = (obj, prefix = '') =>
  Object.entries(obj).flatMap(([k, v]) =>
    v && typeof v === 'object' ? flatten(v, `${prefix}${k}.`) : [[`${prefix}${k}`, String(v)]],
  );

const problems = [];

for (const locale of RTL_LOCALES) {
  for (const file of readdirSync(join(LOCALES_DIR, locale)).filter((f) => f.endsWith('.json'))) {
    const path = join(LOCALES_DIR, locale, file);
    const entries = flatten(JSON.parse(readFileSync(path, 'utf8')));
    for (const [key, value] of entries) {
      for (const match of value.matchAll(RISKY)) {
        if (!/\d/.test(match[0])) continue; // без цифр ран не разрывается
        const before = value.slice(0, match.index);
        const isolated = before.lastIndexOf(LRI) > before.lastIndexOf(PDI);
        if (!isolated) {
          problems.push(`${locale}/${file}:${key}  «${match[0]}» — нужен изолят U+2066…U+2069`);
        }
      }
    }
  }
}

if (problems.length) {
  console.error(`\x1b[31m✗ Bidi: латиница рядом с числом без изолята (${problems.length}):\x1b[0m`);
  for (const p of problems) console.error(`  ${p}`);
  console.error(
    '\nОберните фрагмент в U+2066 … U+2069 — иначе в RTL он отрисуется задом наперёд\n' +
      '(«iPhone 13 128 GB» → «GB 128 13 iPhone»).',
  );
  process.exit(1);
}

console.log('\x1b[32m✓ Bidi чист\x1b[0m — латинско-цифровые фрагменты RTL-локалей изолированы.');
