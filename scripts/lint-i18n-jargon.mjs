#!/usr/bin/env node
/**
 * Линтер «внутренние маркеры не утекают в пользовательские строки».
 *
 * Находка владельца 05.09: экран этапа на кнопке отклонения показывал
 * «Отклонение — только по одному пункту чек-листа с доказательством (ADR-017)».
 * Номер архитектурного решения — адрес документа В ЭТОМ репозитории; человеку
 * за экраном он не говорит ничего, а выглядит как код ошибки. Тем же путём в
 * подсказку удаления аккаунта попало «(crypto-shredding, ADR-035)».
 *
 * Такое приходит не со зла: строку пишут рядом с кодом, где ссылка на решение
 * уместна и полезна, — и вместе с обоснованием она уезжает в 29 локалей, где
 * править её уже дорого. Поэтому проверка машинная, а не «смотреть глазами».
 *
 * ГРАНИЦА, которую линтер держит осознанно, — она же причина двух списков:
 *
 * * `packages/i18n/src/locales` — микрокопия интерфейса. Места объяснить термин
 *   там нет: подпись под кнопкой читают на бегу. Значит запрещены и адреса
 *   внутренних документов, и внутренняя лексика (`crypto-shredding`,
 *   имена полей вроде `integrity_hash`);
 * * `l10n/packs` — опубликованные ЮРИДИЧЕСКИЕ тексты (оферта, политика) со своей
 *   версией и датой вступления в силу. Там `crypto-shredding` — НЕ жаргон, а
 *   введённый и тут же расшифрованный термин («уничтожение ключей шифрования,
 *   после чего данные навсегда нечитаемы»); называть метод своим именем — как
 *   раз то, чего ждут от политики конфиденциальности. Запрещены только адреса
 *   внутренних документов, которым в публичном тексте места нет;
 * * `web/src/mocks` — `detail` ошибок мок-бэкенда. Их легко счесть внутренними
 *   («это же фикстуры»), но экран показывает их ДОСЛОВНО: `StagePage` кладёт
 *   `e.message` прямо в текст ошибки. В демо-режиме, на котором смотрят
 *   тестировщики, это единственный текст, который человек увидит. Оттуда и
 *   пришло «Отклонение требует checklist_item_id (ADR-017)».
 *
 * Скрипт ничего не правит. Выход 1 = «в пользовательской строке внутренний
 * маркер», и чинится это переписыванием строки, а не исключением.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');

// Адреса внутренних документов и разделов — бессмысленны вне репозитория.
// Запрещены в ЛЮБОЙ пользовательской строке, включая юридические тексты.
const DOC_REFS = [
  { re: /\bADR-\d+/g, why: 'номер архитектурного решения (docs/adr/)' },
  { re: /\bDEV-\d+(?:_\d+)?/g, why: 'номер задачи ТЗ фронтенда' },
  { re: /\btech-spec\b/gi, why: 'имя файла техспецификации' },
  { re: /\bdomain-model\b/gi, why: 'имя файла доменной модели' },
  { re: /\bfinmodel\b/gi, why: 'имя файла финмодели' },
  { re: /\bdocs\/[a-z]/g, why: 'путь внутри репозитория' },
  { re: /§\s*\d/g, why: 'ссылка на раздел внутреннего документа' },
];

// Внутренняя лексика: в юридическом тексте её вводят с расшифровкой, в подписи
// под кнопкой — расшифровывать негде.
const JARGON = [
  { re: /crypto-?shredding/gi, why: 'внутренний термин — нужна понятная фраза про уничтожение ключей' },
  {
    re: /\b(integrity_hash|compute_segment|has_business_status|placed_in_cabinet_at|transactional outbox)\b/g,
    why: 'имя поля/механизма из кода',
  },
];

/** Области проверки: интерфейс строже опубликованных юридических текстов. */
const SCOPES = [
  { dir: 'packages/i18n/src/locales', rules: [...DOC_REFS, ...JARGON], what: 'микрокопия интерфейса' },
  { dir: 'l10n/packs', rules: DOC_REFS, what: 'юридические тексты' },
];

/**
 * `detail` ошибок мок-бэкенда — не JSON, поэтому разбирается отдельно: берём
 * третий аргумент `new *MockError(status, code, detail)` — и в кавычках, и в
 * шаблонной строке. `code` (второй аргумент) НЕ проверяем: это машинный
 * контракт с фронтом, он и должен быть `checklist_item_required`.
 */
const MOCKS_DIR = 'web/src/mocks';
const MOCK_ERROR_RE = /new\s+\w*MockError\(\s*\d+\s*,\s*'[^']*'\s*,\s*(?:'([^']*)'|`([^`]*)`)/g;
/** `${milestone.status}` — подставляется ЗНАЧЕНИЕ, имя поля на экран не идёт. */
const INTERPOLATION_RE = /\$\{[^}]*\}/g;
const MOCK_RULES = [
  ...DOC_REFS,
  ...JARGON,
  {
    // Сырое имя поля в тексте для человека: экран покажет его дословно.
    re: /\b[a-z]+(?:_[a-z]+){1,}\b/g,
    why: 'сырое имя поля в тексте, который увидит человек',
  },
];

function walkJson(dir) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out; // области может не быть в частичном чекауте — это не провал линтера
  }
  for (const name of entries) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walkJson(full));
    else if (name.endsWith('.json')) out.push(full);
  }
  return out;
}

/** Обход по расширению — для областей, которые не JSON (мок-бэкенд). */
function walkFiles(dir, ext) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walkFiles(full, ext));
    else if (name.endsWith(ext)) out.push(full);
  }
  return out;
}

/** Плоский обход значений пакета: ключ вида `stage.realRejectHint` + строка. */
function* strings(node, path = '') {
  if (typeof node === 'string') {
    yield [path, node];
  } else if (Array.isArray(node)) {
    for (const [i, v] of node.entries()) yield* strings(v, `${path}[${i}]`);
  } else if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) yield* strings(v, path ? `${path}.${k}` : k);
  }
}

const violations = [];
for (const scope of SCOPES) {
  for (const file of walkJson(join(ROOT, scope.dir))) {
    const rel = relative(ROOT, file).split(sep).join('/');
    let pack;
    try {
      pack = JSON.parse(readFileSync(file, 'utf8'));
    } catch (err) {
      console.error('\x1b[31m✗ %s: не разбирается как JSON — %s\x1b[0m', rel, err.message);
      process.exit(2);
    }
    for (const [key, value] of strings(pack)) {
      for (const rule of scope.rules) {
        rule.re.lastIndex = 0;
        const found = value.match(rule.re);
        if (found) violations.push({ rel, key, marker: found[0], why: rule.why });
      }
    }
  }
}

for (const file of walkFiles(join(ROOT, MOCKS_DIR), '.ts')) {
  const rel = relative(ROOT, file).split(sep).join('/');
  const src = readFileSync(file, 'utf8');
  MOCK_ERROR_RE.lastIndex = 0;
  let m;
  while ((m = MOCK_ERROR_RE.exec(src)) !== null) {
    const detail = (m[1] ?? m[2] ?? '').replace(INTERPOLATION_RE, '…');
    const line = src.slice(0, m.index).split('\n').length;
    for (const rule of MOCK_RULES) {
      rule.re.lastIndex = 0;
      const found = detail.match(rule.re);
      if (found) violations.push({ rel: `${rel}:${line}`, key: detail, marker: found[0], why: rule.why });
    }
  }
}

if (violations.length) {
  // Один и тот же ключ прилетает из 29 локалей — группируем, иначе вывод
  // нечитаем и настоящий масштаб («сколько КЛЮЧЕЙ чинить») теряется.
  const byKey = new Map();
  for (const v of violations) {
    const id = `${v.key} · ${v.marker}`;
    if (!byKey.has(id)) byKey.set(id, { ...v, files: [] });
    byKey.get(id).files.push(v.rel);
  }
  console.error(
    '\x1b[31m✗ Внутренние маркеры в пользовательских строках: %d ключ(ей), %d строк(и):\x1b[0m',
    byKey.size,
    violations.length,
  );
  for (const [id, v] of byKey) {
    console.error('  %s — %s', id, v.why);
    console.error('    %d файл(ов), напр. %s', v.files.length, v.files[0]);
  }
  console.error(
    '\nНомер ADR/задачи — адрес документа в этом репозитории: за экраном он читается как код ошибки.',
  );
  console.error('Смысл сохраняем, ссылку убираем: обоснование остаётся в коде и в самом ADR.');
  process.exit(1);
}

console.log(
  '\x1b[32m✓ Внутренних маркеров в пользовательских строках нет\x1b[0m — %s.',
  [...SCOPES.map((s) => `${s.dir} (${s.what})`), `${MOCKS_DIR} (ошибки мок-бэкенда)`].join(', '),
);
