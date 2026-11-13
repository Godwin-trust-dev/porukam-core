#!/usr/bin/env node
/**
 * Линтер «нет захардкоженных строк в JSX» (ТЗ Фронтенда, DEV-16 §1/§7 ⭐).
 *
 * Все строки интерфейса — через `packages/i18n` (`t('namespace.key')`), не литералами
 * в компонентах. Признак нарушения — кириллица вне i18n-пакетов и вне комментариев:
 * рабочий язык рантайма (`ru`) и есть RU-пакет (`packages/i18n/src/locales/ru`), поэтому
 * любая кириллица, всплывающая где-то ещё в TSX, почти всегда значит, что строка
 * не вынесена в словарь. Это тот же принцип, что в `lint-terms.mjs` (красная линия
 * терминологии) — узкий, высокоточный чек, а не общий «запрет текстовых литералов»
 * (который на голом regex даёт слишком много ложных срабатываний на английском —
 * classNames, data-testid, коды, технические строки).
 *
 * Список исключений — расширяемый (аналогично `lint-terms.mjs`).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, extname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');

// Директории для проверки — только компонентный/страничный слой (ТСХ-рендер).
const TARGETS = ['web/src/pages', 'web/src/features', 'web/src/app', 'packages/ui/src/components'];
const EXTS = new Set(['.tsx']);

// Файлы/паттерны, где кириллица легитимна (не UI-рендер):
// — *.stories.tsx: мок-данные для Storybook, не продовый рендер;
// — *.test.tsx / *.spec.tsx: фикстуры тестов;
// — сами i18n-пакеты сюда не входят (TARGETS их не содержит).
const EXCLUDE_SUFFIXES = ['.stories.tsx', '.test.tsx', '.spec.tsx'];

const COMMENT_LINE_RE = /^\s*(\/\/|\/\*|\*|\{\/\*)/;
const CYRILLIC_RE = /[А-Яа-яЁё]/;

// Точечные исключения — расширяемый список (аналогично `lint-terms.mjs`). Каждая запись —
// осознанное решение, не забытый долг: причина — в комментарии рядом с кодом, не только здесь.
const ALLOWED = new Set([
  // Двухцветный вордмарк «По рукам» — идиома («по рукам!» = рукопожатие), которой нет в
  // других языках; рендерится только при `i18n.language === 'ru'`, иначе — `common.appName`.
  'web/src/pages/ShellLayout.tsx:55',
  // Список сфер в форме профиля — КАТАЛОЖНЫЕ данные (значения хранятся как есть в
  // `CurrentUser.spheres: string[]`, без отдельного code/label — тот же паттерн, что и
  // `contract.sphere`/каталог типов договоров нигде в приложении не переводится).
  // Перевод каталога — вне DEV-16 («Чего не делать»: перевод пользовательского контента;
  // `catalog` — отдельный bounded context, CLAUDE.md §Архитектура).
  'web/src/pages/settings/ProfileSettingsPage.tsx:12',
]);

// Атрибуты, где кириллица — валидные технические значения, не UI-текст
// (напр. `lang="ru"`, `data-*` с русским кодом-ключом маловероятны, но на всякий
// случай — паттерн `dir="ltr"`-подобных строк исключать не нужно, кириллицы там нет).

function walk(dir) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (name === 'node_modules' || name === 'dist') continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...walk(full));
    else if (EXTS.has(extname(full)) && !EXCLUDE_SUFFIXES.some((s) => full.endsWith(s))) out.push(full);
  }
  return out;
}

const violations = [];
for (const t of TARGETS) {
  for (const file of walk(join(ROOT, t))) {
    const lines = readFileSync(file, 'utf8').split(/\r?\n/);
    const rel = relative(ROOT, file).split(sep).join('/');
    let inBlockComment = false; // многострочный /* … */ или {/* … */} без закрытия на той же строке
    lines.forEach((line, i) => {
      if (inBlockComment) {
        if (/\*\//.test(line)) inBlockComment = false;
        return;
      }
      if (COMMENT_LINE_RE.test(line)) {
        if (/\/\*/.test(line) && !/\*\//.test(line)) inBlockComment = true;
        return;
      }
      if (ALLOWED.has(`${rel}:${i + 1}`)) return;
      // Строка кода с хвостовым `// комментарий` — проверяем только код до него (не сам
      // комментарий). Требуем пробел перед `//`, чтобы не задеть `https://` внутри строк.
      const codePart = line.split(/\s\/\/(?!\/)/)[0];
      const m = codePart.match(CYRILLIC_RE);
      if (m) violations.push({ file, line: i + 1, text: line.trim() });
    });
  }
}

if (violations.length) {
  console.error('\x1b[31m✗ Захардкоженный текст в JSX вне i18n-пакетов (%d):\x1b[0m', violations.length);
  for (const v of violations) {
    console.error('  %s:%d  %s', relative(ROOT, v.file), v.line, v.text);
  }
  console.error(
    '\nВсе строки интерфейса — через packages/i18n (t(\'namespace.key\')), не литералами в JSX (DEV-16 §1).',
  );
  process.exit(1);
}

console.log('\x1b[32m✓ Захардкоженных строк не найдено\x1b[0m — %s.', TARGETS.join(', '));
