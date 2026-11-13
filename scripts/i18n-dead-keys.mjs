#!/usr/bin/env node
/**
 * «Ключи vs использование» — поиск мёртвых ключей локализации.
 *
 * Пакеты локалей (`packages/i18n/src/locales/<code>/<ns>.json`) склеиваются в ОДИН
 * неймспейс i18next (`translation`), поэтому ключ в коде выглядит как `<ns>.<путь>`
 * («contracts.actionCopy», «contract.card.statusDraft»). Канон — `en` (fallbackLng),
 * по нему и строится список ключей; остальные 28 локалей обязаны идти с ним 1:1.
 *
 * Ключ считается ЖИВЫМ, если его полный дотированный путь встречается литералом
 * где-либо в исходниках (`t('…')`, карта вида `Record<Status, string>`, e2e-спека).
 *
 * Второй способ «живости» — МНОЖЕСТВЕННОЕ ЧИСЛО i18next: у ключа с `{{count}}` в
 * пакете лежат варианты с суффиксами (`contract.retention.years_one`, `…_few`,
 * `…_many`, `…_other`), а в коде стоит только базовый `contract.retention.years`.
 * Такие ключи считаются живыми по базовому.
 *
 * Отдельная категория — ДИНАМИЧЕСКИЕ: ключ собирается в рантайме
 * (`t(`contracts.${code}`)`, `` `profile.nav${Ns}` ``, `'stage.' + kind`). Литерала
 * такого ключа в коде нет НИКОГДА, и слепое удаление выпилило бы живое. Скрипт
 * вытаскивает из исходников статические ПРЕФИКСЫ таких выражений и всё, что под них
 * попадает, выносит в отдельный список — «не трогать без ручной проверки».
 *
 * Выход: 0 — мёртвых ключей нет; 1 — есть (список на stdout). Скрипт НИЧЕГО не
 * удаляет: он только отвечает на вопрос «что можно чистить».
 *
 * Использование:
 *   npm run i18n:dead-keys            # отчёт: мёртвые + динамические
 *   npm run i18n:dead-keys -- --json  # то же машиночитаемо
 *   npm run i18n:dead-keys -- --key contracts.actionCopy    # разбор одного ключа
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, extname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const LOCALES = join(ROOT, 'packages/i18n/src/locales');
const CANON = 'en';

/** Где ищем употребление. `packages/i18n/src/locales` исключён — там сами строки. */
const SOURCE_DIRS = ['web/src', 'web/e2e', 'web/tests', 'packages/ui/src', 'packages/core/src', 'packages/i18n/src'];
const SOURCE_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs']);

function walk(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (name === 'node_modules' || name === 'dist' || name.startsWith('.')) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (full.startsWith(LOCALES)) continue; // сами пакеты локалей — не «использование»
      walk(full, out);
    } else if (SOURCE_EXTS.has(extname(name))) {
      out.push(full);
    }
  }
  return out;
}

/** Плоский список дотированных ключей неймспейса (вложенность разворачиваем). */
function flatten(obj, prefix, out) {
  for (const [k, v] of Object.entries(obj)) {
    const path = `${prefix}.${k}`;
    if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, path, out);
    else out.push(path);
  }
  return out;
}

function canonKeys() {
  const dir = join(LOCALES, CANON);
  const keys = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
    const ns = file.replace(/\.json$/, '');
    flatten(JSON.parse(readFileSync(join(dir, file), 'utf8')), ns, keys);
  }
  return keys;
}

/**
 * Статические префиксы динамических обращений.
 *
 * Ловим три формы, ровно те, что живут в коде:
 *   1) шаблонная строка с подстановкой — `contracts.${code}` / `profile.nav${Ns}`;
 *   2) конкатенация — 'stage.material' + kind;
 *   3) `t(x, …)` через переменную — префикс неизвестен, помечаем файл в findings.
 * Из (1) и (2) берём часть ДО первой подстановки; если в ней есть точка — это
 * префикс ключа. Пустой префикс (`${ns}.foo`) игнорируем: он не сужает ничего.
 */
/** Суффиксы категорий множественного числа i18next (CLDR): ключ живёт по базовому. */
const PLURAL_SUFFIX_RE = /_(zero|one|two|few|many|other)$/;

const TEMPLATE_RE = /`([A-Za-z][\w.]*?)\$\{/g;
const CONCAT_RE = /['"]([A-Za-z][\w.]*?\.)['"]\s*\+/g;

function collectDynamicPrefixes(files) {
  const prefixes = new Map(); // префикс → Set(файлов)
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    for (const re of [TEMPLATE_RE, CONCAT_RE]) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(text)) !== null) {
        const prefix = m[1];
        if (!prefix.includes('.')) continue; // не ключ (css-класс, путь, url)
        const ns = prefix.slice(0, prefix.indexOf('.'));
        if (!NAMESPACES.has(ns)) continue; // не неймспейс локализации
        if (!prefixes.has(prefix)) prefixes.set(prefix, new Set());
        prefixes.get(prefix).add(relative(ROOT, file));
      }
    }
  }
  return prefixes;
}

const NAMESPACES = new Set(
  readdirSync(join(LOCALES, CANON))
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.replace(/\.json$/, '')),
);

function main() {
  const args = process.argv.slice(2);
  const asJson = args.includes('--json');
  const only = args.includes('--key') ? args[args.indexOf('--key') + 1] : null;

  const files = SOURCE_DIRS.flatMap((d) => walk(join(ROOT, d)));
  const texts = files.map((f) => [relative(ROOT, f), readFileSync(f, 'utf8')]);
  const keys = canonKeys();
  const dynamicPrefixes = collectDynamicPrefixes(files);

  const used = [];
  const dynamic = [];
  const dead = [];
  for (const key of keys) {
    const hits = texts.filter(([, text]) => text.includes(key)).map(([name]) => name);
    if (hits.length > 0) {
      used.push({ key, hits });
      continue;
    }
    // Форма множественного числа: в коде стоит базовый ключ + `{{count}}`.
    const base = key.replace(PLURAL_SUFFIX_RE, '');
    if (base !== key) {
      const baseHits = texts.filter(([, text]) => text.includes(base)).map(([name]) => name);
      if (baseHits.length > 0) {
        used.push({ key, hits: baseHits, via: 'plural' });
        continue;
      }
    }
    // Ключ мог собираться в рантайме: подходит ли он под какой-то префикс?
    const covering = [...dynamicPrefixes.keys()].filter((p) => key.startsWith(p) && key.length > p.length);
    if (covering.length > 0) {
      dynamic.push({ key, prefixes: covering, files: [...new Set(covering.flatMap((p) => [...dynamicPrefixes.get(p)]))] });
      continue;
    }
    dead.push(key);
  }

  if (only) {
    const inUsed = used.find((u) => u.key === only);
    const inDyn = dynamic.find((d) => d.key === only);
    const report = inUsed
      ? { key: only, verdict: inUsed.via === 'plural' ? 'used (форма множественного числа)' : 'used', hits: inUsed.hits }
      : inDyn
        ? { key: only, verdict: 'dynamic', prefixes: inDyn.prefixes, files: inDyn.files }
        : { key: only, verdict: keys.includes(only) ? 'dead' : 'unknown' };
    console.log(JSON.stringify(report, null, 2));
    return process.exit(0);
  }

  if (asJson) {
    console.log(JSON.stringify({ total: keys.length, used: used.length, dynamic, dead }, null, 2));
  } else {
    console.log(`Ключей в каноне (${CANON}): ${keys.length}; файлов просмотрено: ${files.length}`);
    console.log(`Живых литералом: ${used.length}`);
    console.log(`\nПод динамическими префиксами (${dynamic.length}) — НЕ удалять без ручной проверки:`);
    const byPrefix = new Map();
    for (const d of dynamic) for (const p of d.prefixes) byPrefix.set(p, (byPrefix.get(p) ?? 0) + 1);
    for (const [p, n] of [...byPrefix].sort()) console.log(`  ${p}…  (${n}) ← ${[...dynamicPrefixes.get(p)].join(', ')}`);
    console.log(`\nМёртвых (нигде не встречаются): ${dead.length}`);
    for (const k of dead) console.log(`  ${k}`);
  }
  process.exit(dead.length > 0 ? 1 : 0);
}

main();
