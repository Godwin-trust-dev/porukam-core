#!/usr/bin/env node
/**
 * Линтер терминологической красной линии (ТЗ Фронтенда §6, ADR-049).
 *
 * Подмена трудовых отношений подрядными — юридический риск, а не стилистика.
 * Наличие запрещённой лексики в строках локализации (packages/i18n) или в
 * литералах UI (web/src) => красный билд (exit 1).
 *
 * Список расширяемый. Русские стоп-слова матчатся по началу словоформы
 * (учёт склонений), латинские code/URL-токены — по границам слова.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, extname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');

// Русская лексика языка труда (матч по корню, ловит склонения).
const RU_ROOTS = [
  // «персональные данные» — легитимный юридический термин (152-ФЗ), не «персонал».
  'персонал(?!ьн)',
  'сотрудник',
  'штат',
  'ваканси',
  'найм',
  'нанят', // наняты/нанятый в контексте трудоустройства
  'работодател',
  'трудоустройств',
  'зарплат',
  'график работы',
  'биржа труда',
];

// Латинские токены в code/URL/событиях аналитики (§1.5 техспецификации).
const LAT_WORDS = ['vacancies', 'vacancy', 'staff', 'employee', 'employees', 'employer', 'salary', 'payroll', 'hiring'];

// Директории для проверки.
const TARGETS = ['packages/i18n/src', 'web/src'];
const EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.json']);

/**
 * Правило «юрисдикция → деньги» (DEV-05-PATCH, ADR-032; DEV-07 §0): в money-компонентах
 * экрана подписания/платежа запрещены захардкоженные денежные литералы (%, ₽, «комиссия»,
 * «без комиссии», «СБП») — данные и копирайт обязаны идти из `paymentPolicy` + i18n-ключей,
 * не из строк/чисел в TSX. Строки-комментарии (// и блочные) не проверяются —
 * правило про рендерящийся текст и логику, не про пояснения в коде.
 */
// Чистые money-компоненты — % встречается только как денежный литерал.
const MONEY_COMPONENT_FILES = [
  'packages/ui/src/components/PaymentPolicyLine.tsx',
  'packages/ui/src/components/CommissionSection.tsx',
  'packages/ui/src/components/FeePaymentSbp.tsx',
  'packages/ui/src/components/PaymentBreakdown.tsx',
  'packages/ui/src/components/PaymentMethodPicker.tsx',
  'packages/ui/src/components/SbpPay.tsx',
  'packages/ui/src/components/CashConfirm.tsx',
  'packages/ui/src/components/PaymentResult.tsx',
];
// Страницы подписания/платежа — % встречается и в непричастной вёрстке (width="60%" у Skeleton) —
// строки с width=/height= (размеры плейсхолдеров, не деньги) из проверки исключаем.
const MONEY_PAGE_FILES = ['web/src/pages/SigningPage.tsx', 'web/src/pages/PaymentPage.tsx'];
const MONEY_LITERAL_RE = /%|₽|комисси|сбп/iu;
const COMMENT_LINE_RE = /^\s*(\/\/|\/\*|\*|\{\/\*)/;
const DIMENSION_LINE_RE = /\bwidth=|\bheight=/;

const moneyViolations = [];
function scanMoneyFile(rel, { skipDimensions = false } = {}) {
  const file = join(ROOT, rel);
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return;
  }
  text.split(/\r?\n/).forEach((line, i) => {
    if (COMMENT_LINE_RE.test(line)) return;
    if (skipDimensions && DIMENSION_LINE_RE.test(line)) return;
    const m = line.match(MONEY_LITERAL_RE);
    if (m) moneyViolations.push({ file, line: i + 1, term: m[0], text: line.trim() });
  });
}
for (const rel of MONEY_COMPONENT_FILES) scanMoneyFile(rel);
for (const rel of MONEY_PAGE_FILES) scanMoneyFile(rel, { skipDimensions: true });

if (moneyViolations.length) {
  console.error('\x1b[31m✗ Денежный литерал в money-компоненте (%d):\x1b[0m', moneyViolations.length);
  for (const v of moneyViolations) {
    console.error('  %s:%d  «%s»  →  %s', relative(ROOT, v.file), v.line, v.term, v.text);
  }
  console.error('\nТолько `paymentPolicy` + i18n-ключи (DEV-05-PATCH, ADR-032) — без литералов %/₽/«комиссия» в коде.');
  process.exit(1);
}

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
    else if (EXTS.has(extname(full))) out.push(full);
  }
  return out;
}

const ruRe = new RegExp('(' + RU_ROOTS.map((r) => r.replace(/\s+/g, '\\s+')).join('|') + ')', 'iu');
const latRe = new RegExp('\\b(' + LAT_WORDS.join('|') + ')\\b', 'i');

const violations = [];
for (const t of TARGETS) {
  for (const file of walk(join(ROOT, t))) {
    const lines = readFileSync(file, 'utf8').split(/\r?\n/);
    lines.forEach((line, i) => {
      const ru = line.match(ruRe);
      const lat = line.match(latRe);
      if (ru) violations.push({ file, line: i + 1, term: ru[0], text: line.trim() });
      if (lat) violations.push({ file, line: i + 1, term: lat[0], text: line.trim() });
    });
  }
}

if (violations.length) {
  console.error('\x1b[31m✗ Терминологическая красная линия нарушена (%d):\x1b[0m', violations.length);
  for (const v of violations) {
    console.error('  %s:%d  «%s»  →  %s', relative(ROOT, v.file), v.line, v.term, v.text);
  }
  console.error('\nЯзык труда запрещён в UI. Используйте язык подряда: исполнитель, заказчик, проект, оплата за результат.');
  process.exit(1);
}

/**
 * Финмодель v2 (DEV-05-PATCH v2, docs/tasks/DEV-05-patch_jurisdiction-money.md §A/§B.9):
 * комиссия за заключение отменена полностью, монетизация подпиской — следующая
 * волна, сейчас не проектируем. UI не должен намекать на тарифы/планы/подписку
 * или на возврат комиссии за заключение.
 *
 * Скопировано узко, НЕ бэп-словами «тариф»/«план» — они легитимно живут в других
 * контекстах («тариф оператора» перевода не в РФ-юрисдикции, ADR-055; «план
 * расчётов» — PaymentPlan, DEV-06). Запрещаем только сочетания, однозначно
 * указывающие на монетизацию платформы. Комментарии (// и блочные) не проверяем —
 * объяснять ОТМЕНЁННУЮ фичу в комментарии можно, рендерить её в UI — нет.
 */
const V2_MONEY_ROOTS = ['подписк', 'тарифн\\w*\\s+план', 'план\\w*\\s+подписк', 'комисси\\w*\\s+за\\s+заключени'];
const v2Re = new RegExp('(' + V2_MONEY_ROOTS.join('|') + ')', 'iu');

const v2Violations = [];
for (const t of TARGETS) {
  for (const file of walk(join(ROOT, t))) {
    const lines = readFileSync(file, 'utf8').split(/\r?\n/);
    lines.forEach((line, i) => {
      if (COMMENT_LINE_RE.test(line)) return;
      const m = line.match(v2Re);
      if (m) v2Violations.push({ file, line: i + 1, term: m[0], text: line.trim() });
    });
  }
}

if (v2Violations.length) {
  console.error('\x1b[31m✗ Лексика монетизации в UI запрещена (финмодель v2, %d):\x1b[0m', v2Violations.length);
  for (const v of v2Violations) {
    console.error('  %s:%d  «%s»  →  %s', relative(ROOT, v.file), v.line, v.term, v.text);
  }
  console.error(
    '\nКомиссия за заключение отменена полностью; про тарифы/планы/подписку в UI — ничего, даже плейсхолдера (см. docs/tasks/DEV-05-patch_jurisdiction-money.md).',
  );
  process.exit(1);
}

/**
 * Push — платформо-нейтральные строки (DEV-14 §0/§5 ⭐, ADR-060 GLOBAL): push будет и в
 * вебе, и в приложении — UI-копирайт один и тот же, без слов «web»/«браузер». Комментарии
 * (// и блочные) не проверяем — путь `web/CLAUDE.md`/`web/src/...` в пояснениях допустим,
 * запрещаем только то, что реально рендерится/пишется в UI-строки.
 */
const PUSH_NEUTRAL_RE = /браузер|\bweb\b/iu;

/**
 * Единственное исключение из правила — подсказка «сделайте Chrome браузером по
 * умолчанию» (`pwa.json`, ключи `defaultBrowser*`, 10.09). Обёртка из Play
 * открывает страницу браузером ПО УМОЛЧАНИЮ, и от этого выбора зависит,
 * дойдут ли уведомления вообще: делегированную доставку из приложения умеет
 * только Chrome, а Samsung Internet вдобавок инвертирует палитру. Заставить
 * обёртку открываться в Chrome кодом нельзя — проверено; остаётся сказать это
 * человеку словами и провести по системным настройкам, где пункт так и
 * называется — «Браузер».
 *
 * То есть это не push-копирайт (он остаётся платформо-нейтральным:
 * «разрешите приложению отправлять уведомления»), а инструкция по настройке
 * телефона — тот же случай, что справка `help.json` строкой ниже.
 */
const PUSH_NEUTRAL_KEY_EXCEPTION = /^\s*"defaultBrowser\w*"\s*:/;

const pushNeutralViolations = [];
for (const t of TARGETS) {
  for (const file of walk(join(ROOT, t))) {
    // Справка (help.json: FAQ «Работает ли на телефоне?») легитимно объясняет
    // установку PWA из браузера — правило про push-копирайт, не про инструкции.
    if (file.endsWith('help.json')) continue;
    const lines = readFileSync(file, 'utf8').split(/\r?\n/);
    lines.forEach((line, i) => {
      if (COMMENT_LINE_RE.test(line)) return;
      if (PUSH_NEUTRAL_KEY_EXCEPTION.test(line)) return;
      const m = line.match(PUSH_NEUTRAL_RE);
      if (m) pushNeutralViolations.push({ file, line: i + 1, term: m[0], text: line.trim() });
    });
  }
}

if (pushNeutralViolations.length) {
  console.error('\x1b[31m✗ Платформенная лексика «web»/«браузер» запрещена в UI (%d):\x1b[0m', pushNeutralViolations.length);
  for (const v of pushNeutralViolations) {
    console.error('  %s:%d  «%s»  →  %s', relative(ROOT, v.file), v.line, v.term, v.text);
  }
  console.error(
    '\nPush и его копирайт — платформо-нейтральные (DEV-14 §5): «разрешите приложению отправлять уведомления», без «web»/«браузер».',
  );
  process.exit(1);
}

/**
 * «Канон» на подписании — DEV-16b §0/§4/§7 ⭐: аудитория простые люди, канон НЕ выпячиваем.
 * UI говорит «официальный текст», не «канон/канонический» (термин остаётся в коде/API/ADR —
 * комментарии не проверяем, только то, что рендерится в UI-строки).
 */
const CANON_RE = /канон|\bcanon(ical)?\b/iu;

const canonViolations = [];
for (const t of TARGETS) {
  for (const file of walk(join(ROOT, t))) {
    const lines = readFileSync(file, 'utf8').split(/\r?\n/);
    lines.forEach((line, i) => {
      if (COMMENT_LINE_RE.test(line)) return;
      const m = line.match(CANON_RE);
      if (m) canonViolations.push({ file, line: i + 1, term: m[0], text: line.trim() });
    });
  }
}

if (canonViolations.length) {
  console.error('\x1b[31m✗ Слово «канон/canonical» запрещено в UI-строках (%d):\x1b[0m', canonViolations.length);
  for (const v of canonViolations) {
    console.error('  %s:%d  «%s»  →  %s', relative(ROOT, v.file), v.line, v.term, v.text);
  }
  console.error(
    '\nПодписание — для простых людей, канон не выпячиваем (DEV-16b §0): «официальный текст», не «канон».',
  );
  process.exit(1);
}

console.log('\x1b[32m✓ Терминология чистая\x1b[0m — запрещённой лексики не найдено (%s).', TARGETS.join(', '));
