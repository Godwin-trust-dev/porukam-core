/**
 * Системный проход фронта на мобильном (и контроль 768/1280) — Playwright.
 *
 * Зачем: раз в волну прогонять ВСЕ экраны на 390×844 и ловить механические
 * дефекты вёрстки (горизонтальный скролл страницы, вылеты за вьюпорт,
 * обрезанный текст без «…», мелкие тач-цели, наложения) + снимать fullPage-
 * скриншоты, чтобы отсмотреть их глазами.
 *
 * Запуск (dev-сервер на MSW-моках должен быть уже поднят):
 *   npx vite --port 4240            # в web/
 *   OUT=/tmp/pass W=390 node scripts/probe/mobile-pass.mjs
 *
 * Переменные окружения:
 *   BASE  — адрес дев-сервера (по умолчанию http://localhost:4240)
 *   OUT   — куда складывать скриншоты и report.txt (обязательна)
 *   W     — ширина вьюпорта: 390 | 768 | 1280 (по умолчанию 390)
 *   ONLY  — regexp по имени сценария, чтобы прогнать часть
 */
import { chromium } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';

const BASE = process.env.BASE ?? 'http://localhost:4240';
const OUT = process.env.OUT;
const W = Number(process.env.W ?? 390);
const H = W === 390 ? 844 : W === 768 ? 1024 : 900;
const ONLY = process.env.ONLY ? new RegExp(process.env.ONLY) : null;
if (!OUT) throw new Error('OUT is required');
mkdirSync(OUT, { recursive: true });

const lines = [];
const log = (s) => {
  lines.push(s);
  console.log(s);
};

/** Аудит одного экрана: механические дефекты вёрстки. Выполняется в браузере. */
const AUDIT = ({ W }) => {
  // Визуально скрытые (sr-only) — не дефект: их клипают намеренно.
  const srOnly = (el) => {
    const cs = getComputedStyle(el);
    const b = el.getBoundingClientRect();
    return (b.width <= 2 && b.height <= 2) || cs.clip === 'rect(0px, 0px, 0px, 0px)' || cs.clipPath === 'inset(50%)';
  };
  // Липкие и фиксированные слои (шапка, нижняя навигация, модалка, cookie-
  // баннер, нижняя панель действий «Сдать этап») лежат поверх контента по
  // замыслу — это не «наложение вёрстки».
  const floatingAncestor = (el) => {
    for (let p = el; p && p !== document.body; p = p.parentElement) {
      const pos = getComputedStyle(p).position;
      if (pos === 'fixed' || pos === 'sticky') return true;
    }
    return false;
  };
  const vis = (el) => {
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0.01;
  };
  const name = (el) => {
    const cls = typeof el.className === 'string' ? el.className.split(' ').filter(Boolean).slice(0, 2).join('.') : '';
    return `${el.tagName.toLowerCase()}${cls ? '.' + cls : ''}${el.dataset.testid ? `[${el.dataset.testid}]` : ''}`;
  };
  const txt = (el) => (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 48);
  const all = [...document.querySelectorAll('body *')].filter((el) => {
    const b = el.getBoundingClientRect();
    return b.width > 0 && b.height > 0 && vis(el);
  });

  // 1. вылет за вьюпорт; горизонтально прокручиваемые полосы — отдельно
  const scrollerOf = (el) => {
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      const ox = getComputedStyle(p).overflowX;
      if (ox === 'auto' || ox === 'scroll') return p;
    }
    return null;
  };
  const overflow = [];
  const inScroller = new Map();
  for (const el of all) {
    const b = el.getBoundingClientRect();
    if (b.right <= W + 1 && b.left >= -1) continue;
    const sc = scrollerOf(el);
    if (sc) {
      const key = name(sc);
      const cur = inScroller.get(key) ?? { scrollable: sc.scrollWidth > sc.clientWidth + 1, sw: sc.scrollWidth, cw: sc.clientWidth, n: 0 };
      cur.n += 1;
      inScroller.set(key, cur);
      continue;
    }
    if (overflow.some((o) => o.el.contains(el))) continue;
    overflow.push({ el, s: `${name(el)} left=${Math.round(b.left)} right=${Math.round(b.right)} w=${Math.round(b.width)} «${txt(el)}»` });
  }

  // 2. текст, обрезанный overflow:hidden без многоточия
  const clipped = [];
  for (const el of all) {
    const cs = getComputedStyle(el);
    if (cs.textOverflow === 'ellipsis') continue;
    if (srOnly(el)) continue;
    if (!el.textContent || !el.textContent.trim()) continue;
    if (cs.overflowX === 'hidden' && el.scrollWidth > el.clientWidth + 2) {
      clipped.push(`${name(el)} scrollW=${el.scrollWidth}>clientW=${el.clientWidth} «${txt(el)}» (X)`);
    } else if (cs.overflowY === 'hidden' && el.scrollHeight > el.clientHeight + 2) {
      clipped.push(`${name(el)} scrollH=${el.scrollHeight}>clientH=${el.clientHeight} «${txt(el)}» (Y)`);
    }
  }

  // 3. мелкие тач-цели. Ссылки внутри текста (display:inline) считаем отдельно:
  //    строчная ссылка в абзаце не обязана быть 40px, кнопка — обязана.
  const small = [];
  const smallLinks = [];
  for (const el of all) {
    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute('role');
    const interactive = tag === 'button' || tag === 'a' || tag === 'select' || role === 'button' || role === 'tab' ||
      (tag === 'input' && !['hidden', 'checkbox', 'radio'].includes(el.type));
    if (!interactive) continue;
    if (srOnly(el)) continue;
    const b = el.getBoundingClientRect();
    if (b.height >= 40) continue;
    const s = `${name(el)} ${Math.round(b.width)}×${Math.round(b.height)} «${txt(el)}»`;
    (tag === 'a' || getComputedStyle(el).display === 'inline' ? smallLinks : small).push(s);
  }

  // 4. наложения соседних текстовых блоков
  const leaves = all.filter((el) => el.children.length === 0 && (el.textContent || '').trim().length > 1);
  const overlap = [];
  outer: for (let i = 0; i < leaves.length; i++) {
    for (let j = i + 1; j < leaves.length; j++) {
      const a = leaves[i], b = leaves[j];
      if (a.contains(b) || b.contains(a)) continue;
      const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
      const iw = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left);
      const ih = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top);
      if (iw <= 1 || ih <= 1) continue;
      const minA = Math.min(ra.width * ra.height, rb.width * rb.height);
      if ((iw * ih) / minA < 0.4) continue;
      if (getComputedStyle(a).position === 'absolute' || getComputedStyle(b).position === 'absolute') continue;
      if (floatingAncestor(a) || floatingAncestor(b)) continue;
      overlap.push(`${name(a)} «${txt(a)}» × ${name(b)} «${txt(b)}»`);
      if (overlap.length > 6) break outer;
    }
  }

  // 5. модалка выше экрана без собственной прокрутки
  const modals = [];
  for (const el of document.querySelectorAll('[role="dialog"], dialog')) {
    if (!vis(el)) continue;
    const b = el.getBoundingClientRect();
    const scrollable = [el, ...el.querySelectorAll('*')].some((n) => {
      const oy = getComputedStyle(n).overflowY;
      return (oy === 'auto' || oy === 'scroll') && n.scrollHeight > n.clientHeight + 2;
    });
    const cut = b.bottom > window.innerHeight + 1 || b.top < -1;
    if (cut && !scrollable) modals.push(`${name(el)} top=${Math.round(b.top)} bottom=${Math.round(b.bottom)} — вне экрана и НЕ прокручивается`);
    else if (cut) modals.push(`${name(el)} top=${Math.round(b.top)} bottom=${Math.round(b.bottom)} — прокрутка внутри есть`);
  }

  return {
    docW: document.documentElement.scrollWidth,
    overflow: overflow.map((o) => o.s).slice(0, 10),
    scrollers: [...inScroller.entries()].map(([k, v]) => `${k} ${v.scrollable ? 'OK-scrollable' : '!!NOT-scrollable'} sw=${v.sw}/cw=${v.cw} items=${v.n}`),
    clipped: [...new Set(clipped)].slice(0, 10),
    small: [...new Set(small)].slice(0, 10),
    smallLinks: [...new Set(smallLinks)].slice(0, 6),
    overlap: [...new Set(overlap)].slice(0, 6),
    modals,
  };
};

let page;
let count = 0;
async function shot(name) {
  // Скролл наверх: fullPage-снимок рисует position:fixed на текущем смещении,
  // иначе шапка/нижняя навигация «зависают» посреди картинки.
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(450);
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: true });
  const r = await page.evaluate(AUDIT, { W });
  count += 1;
  const bad = r.docW > W + 1 || r.overflow.length || r.clipped.length || r.small.length || r.overlap.length ||
    r.modals.length || r.scrollers.some((s) => s.includes('NOT-scrollable'));
  log(`\n## ${name} — ${page.url().replace(BASE, '')}${bad ? '' : ' clean'}`);
  if (r.docW > W + 1) log(`  !! h-scroll страницы: scrollWidth=${r.docW} > ${W}`);
  for (const s of r.overflow) log(`  !! вылет: ${s}`);
  for (const s of r.scrollers) log(`  .. в полосе: ${s}`);
  for (const s of r.clipped) log(`  !! обрезан: ${s}`);
  for (const s of r.small) log(`  !! тач<40: ${s}`);
  for (const s of r.smallLinks) log(`  ~~ ссылка<40: ${s}`);
  for (const s of r.overlap) log(`  !! наложение: ${s}`);
  for (const s of r.modals) log(`  !! модалка: ${s}`);
}

async function go(name, path, act) {
  if (ONLY && !ONLY.test(name)) return;
  try {
    await page.goto(BASE + path, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(900);
    if (act) await act();
    await shot(name);
  } catch (e) {
    log(`\n## ${name} — ${path}\n  XX ошибка сценария: ${String(e).split('\n')[0]}`);
  }
}

const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: W, height: H },
  deviceScaleFactor: 1,
  isMobile: W === 390,
  hasTouch: W === 390,
  locale: 'ru-RU',
});
page = await ctx.newPage();
page.on('pageerror', (e) => log(`  XX pageerror: ${e.message.split('\n')[0]}`));

// Отчёт пишем при любом исходе: частичный прогон (ONLY=...) не должен
// оставлять OUT без report.txt.
process.on('exit', () => {
  try {
    writeFileSync(`${OUT}/report.txt`, lines.join('\n'));
  } catch { /* нечего писать */ }
});

// ── гость ────────────────────────────────────────────────────────────────
await go('g01_welcome', '/welcome');
await go('g02_login', '/login');
await go('g03_public_card', '/@akovalev');
await go('g04_public_card_empty', '/@novichok');
await go('g05_public_card_closed', '/@zakrytyi');
await go('g06_public_group', '/@teplo_remont');
await go('g07_public_404', '/@net_takogo_handle');

// ── вход ─────────────────────────────────────────────────────────────────
await page.goto(`${BASE}/login`);
await page.getByLabel('Номер телефона').fill('+7 900 123-45-67');
await page.getByRole('checkbox').first().check();
await page.getByRole('button', { name: 'Получить код' }).click();
await page.getByLabel('Код подтверждения').fill('111111');
await page.getByRole('button', { name: 'Войти' }).click();
await page.waitForURL((u) => !/\/login/.test(u.pathname), { timeout: 20000 });
await page.waitForTimeout(1200);

// ── онбординг ────────────────────────────────────────────────────────────
await go('o01_consents', '/onboarding/consents');
await go('o02_profile', '/onboarding/profile');
await go('o03_backup', '/onboarding/backup');

// ── основные разделы ─────────────────────────────────────────────────────
await go('a01_dashboard', '/');
await go('a02_contracts', '/contracts');
await go('a02b_contracts_archive', '/contracts', async () => {
  const t = page.getByRole('tab').nth(1);
  if (await t.count()) { await t.click(); await page.waitForTimeout(700); }
});
await go('a02c_contracts_drafts', '/contracts', async () => {
  const t = page.getByRole('tab').nth(2);
  if (await t.count()) { await t.click(); await page.waitForTimeout(700); }
});
// Нижний лист фильтров — только на узком экране: с 640px фильтры инлайновые.
await go('a02d_contracts_filters', '/contracts', async () => {
  const b = page.getByTestId('open-filters');
  if (!(await b.isVisible().catch(() => false))) throw new Error('фильтры инлайновые — листа нет');
  await b.click();
  await page.waitForTimeout(700);
});
await go('a02e_contracts_empty', '/contracts', async () => {
  const f = page.locator('input[type="search"], input[type="text"]').first();
  if (await f.count()) { await f.fill('нетничеготакого'); await page.waitForTimeout(1000); }
});
await go('a03_notifications', '/notifications');
await go('a04_me', '/me');
await go('a05_portfolio', '/me/portfolio');
await go('a06_portfolio_modal', '/me/portfolio', async () => {
  const b = page.getByRole('button', { name: /Добавить проект|Новый проект|Добавить/ }).first();
  if (await b.count()) { await b.click(); await page.waitForTimeout(500); }
});
await go('a07_contacts', '/me/contacts');
await go('a08_about', '/help/about');
await go('a09_faq', '/help/faq');
await go('a10_esica', '/me/verify/esica');
await go('a11_search', '/search');
await go('a12_search_query', '/search', async () => {
  const f = page.locator('input[type="search"], input[type="text"]').first();
  if (await f.count()) { await f.fill('@marat'); await page.waitForTimeout(1200); }
});
await go('a13_stages', '/stages');
await go('a14_payments', '/payments');
await go('a15_disputes', '/disputes');
await go('a16_reputation', '/reputation');
await go('a17_rep_profile', '/reputation/profiles/pf-mock-contractor-1');
await go('a18_chat', '/chat');
await go('a19_chat_new', '/chat/new');
await go('a20_chat_thread', '/chat/rc-progress-1');
await go('a21_organizations_new', '/organizations/new');

// ── настройки ────────────────────────────────────────────────────────────
await go('s01_profile', '/me/settings/profile');
await go('s03_privacy', '/me/settings/privacy');
await go('s04_notifications', '/me/settings/notifications');
await go('s05_app', '/me/settings/app');
await go('s06_account', '/me/settings/account');
await go('s07_account_delete', '/me/settings/account/delete');

// ── объединения ──────────────────────────────────────────────────────────
await go('r01_groups', '/groups');
await go('r02_groups_new', '/groups', async () => {
  const b = page.getByRole('button', { name: /Создать объединение|Создать/ }).first();
  if (await b.count()) { await b.click(); await page.waitForTimeout(600); }
});
await go('r03_group_1', '/groups/grp-1');
await go('r04_group_3', '/groups/grp-3');
await go('r05_group_invite', '/groups/grp-3', async () => {
  const f = page.getByTestId('group-invite-handle');
  if (!(await f.count())) throw new Error('нет поля приглашения');
  await f.fill('@novichok');
  await page.waitForTimeout(400);
});

// ── карточки договоров ───────────────────────────────────────────────────
const REAL_TABS = ['overview', 'terms', 'stages', 'payments', 'chat', 'negoSign', 'timeline'];
for (const [cid, label] of [['rc-draft-1', 'draft'], ['rc-progress-1', 'progress'], ['rc-review-1', 'review'], ['rc-awaiting-my-turn-1', 'await']]) {
  for (const tab of REAL_TABS) {
    await go(`c_${label}_${tab}`, `/contracts/${cid}`, async () => {
      const t = page.getByTestId(`tab-${tab}`);
      if (!(await t.count())) throw new Error(`нет вкладки ${tab}`);
      await t.click();
      await page.waitForTimeout(700);
    });
  }
}
await go('c_legacy_overview', '/contracts/c-7001/overview');
await go('c_legacy_stages', '/contracts/c-7001/stages');
await go('c_legacy_money', '/contracts/c-7001/money');
await go('c_legacy_history', '/contracts/c-7001/history');
await go('c_draft_edit_modal', '/contracts/rc-draft-1', async () => {
  const b = page.getByRole('button', { name: /Предложить правку|Правка/ }).first();
  if (await b.count()) { await b.click(); await page.waitForTimeout(700); }
});

// ── этапы / оплаты / подписание / приёмка / архив ────────────────────────
/** Экран этапа открыт только исполнителю — переключаем зрителя. */
async function asContractor() {
  const b = page.getByRole('button', { name: /Смотреть как исполнитель/ }).first();
  if (await b.count()) { await b.click(); await page.waitForTimeout(900); }
}
await go('e01_stage_9101', '/contracts/c-9101/stages/st-9101', asContractor);
await go('e02_stage_9102', '/contracts/c-9102/stages/st-9102', asContractor);
await go('e03_stage_9103', '/contracts/c-9103/stages/st-9103', asContractor);
await go('e03b_stage_9104', '/contracts/c-9104/stages/st-9104', asContractor);
await go('e03c_stage_9105', '/contracts/c-9105/stages/st-9105', asContractor);
await go('e04_stage_hints', '/contracts/c-9101/stages/st-9101', async () => {
  await asContractor();
  for (const h of await page.locator('[data-testid^="field-help"], button:text-is("?")').all()) {
    try { await h.click({ timeout: 800 }); } catch { /* пропускаем */ }
  }
  await page.waitForTimeout(400);
});
await go('e05_payment', '/contracts/c-5002/payments/pay-cash-demo');
await go('e06_payment_failed', '/contracts/c-5002/payments/pay-failed-demo');
await go('e07_payment_new', '/contracts/c-5001/payments/new');
await go('e08_sign', '/contracts/rc-awaiting-my-turn-1/sign');
await go('e09_review', '/contracts/rc-review-1/review');
// Протокол разногласий — экран мок-контура (реальный id уводит на карточку).
await go('e09b_review_reject', '/contracts/c-6001/review', async () => {
  const b = page.getByRole('button', { name: /Отклонить/ }).first();
  if (!(await b.count())) throw new Error('нет кнопки «Отклонить»');
  await b.click();
  await page.waitForTimeout(700);
});
await go('e09c_withdraw_confirm', '/contracts/rc-awaiting-my-turn-1', async () => {
  const b = page.getByRole('button', { name: /Отозвать/ }).first();
  if (!(await b.count())) throw new Error('нет кнопки «Отозвать»');
  await b.click();
  await page.waitForTimeout(700);
});
await go('e10_archive', '/contracts/rc-progress-1/archive');

// ── мастер создания договора ─────────────────────────────────────────────
/** Заполнить пустые видимые поля шага, чтобы «Далее» разблокировалась. */
async function fillVisibleFields() {
  for (const inp of await page.locator('input:not([type=hidden]):not([type=checkbox]):not([type=radio]):not([type=file]), textarea').all()) {
    try {
      if (!(await inp.isVisible()) || (await inp.isDisabled())) continue;
      if (await inp.inputValue()) continue;
      const type = await inp.getAttribute('type');
      // Денежные/числовые поля отличаем по подписи: текст в «Цену» не проходит
      // валидацию, и «Далее» остаётся заблокированной.
      const label = await inp.evaluate((el) => {
        const own = `${el.getAttribute('aria-label') ?? ''} ${el.getAttribute('name') ?? ''} ${el.getAttribute('placeholder') ?? ''}`;
        const lab = el.id ? document.querySelector(`label[for="${el.id}"]`) : null;
        return `${own} ${lab?.textContent ?? ''}`;
      });
      const numericByLabel = /цена|сумм|стоим|платеж|платёж|процент|ставк|количеств|срок|дней|часов|amount|price/i.test(label);
      if (type === 'number' || (await inp.getAttribute('inputmode')) === 'numeric' || numericByLabel) await inp.fill('150000');
      else if (type === 'date') await inp.fill('2026-09-01');
      else await inp.fill('Тестовое значение поля');
    } catch { /* поле недоступно — пропускаем */ }
  }
  for (const sel of await page.locator('select').all()) {
    try {
      if (!(await sel.isVisible()) || (await sel.isDisabled())) continue;
      if (await sel.inputValue()) continue;
      const opts = await sel.locator('option').all();
      for (const o of opts) {
        const v = await o.getAttribute('value');
        if (v) { await sel.selectOption(v); break; }
      }
    } catch { /* пропускаем */ }
  }
  await page.waitForTimeout(600);
}

const WIZ = [['service', 'type-service'], ['sale', 'type-sale'], ['rent', 'type-rent_items'], ['loan', 'type-loan']];
for (const [kind, testid] of WIZ) {
  if (ONLY && !ONLY.test(`w_${kind}`)) continue;
  try {
    // Черновик мастера переживает переходы (zustand/persist): без сброса
    // следующий тип продолжал прошлый черновик и упирался в «Договор не найден».
    await page.goto(`${BASE}/contracts/new/type`, { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => localStorage.removeItem('porukam.contractNew'));
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1000);
    if (kind === 'service') await shot('w_00_type');
    const t = page.getByTestId(testid);
    if (!(await t.count())) { log(`\n## w_${kind} — нет ${testid}`); continue; }
    await t.click();
    await page.waitForTimeout(500);
    const sub = page.locator('[data-testid^="subtype-"]').first();
    if (await sub.count()) { await sub.click(); await page.waitForTimeout(400); }
    await shot(`w_${kind}_01_type`);
    for (let i = 0; i < 8; i++) {
      const next = page.getByTestId('wizard-next');
      if (!(await next.count())) { log(`\n## w_${kind} — нет кнопки «Далее» на ${page.url().split('/').pop()}`); break; }
      if (await next.isDisabled()) { await shot(`w_${kind}_${i}_next_disabled`); break; }
      const before = page.url();
      await next.click();
      await page.waitForTimeout(1400);
      const url = page.url();
      if (url === before) { await shot(`w_${kind}_${i}_stuck`); break; }
      const step = url.split('/').pop();
      if (step === 'sphere') {
        await shot(`w_${kind}_02_sphere`);
        const sp = page.locator('button[data-testid^="sphere-"]:not([data-testid="sphere-browse-all"])').first();
        if (await sp.count()) { await sp.click(); await page.waitForTimeout(700); }
        const wt = page.locator('[data-testid^="work-type-"]').first();
        if (await wt.count()) { await wt.click(); await page.waitForTimeout(500); }
        await shot(`w_${kind}_02_sphere_picked`);
      } else if (step === 'parties') {
        await shot(`w_${kind}_03_parties`);
        const s = page.getByTestId('counterparty-search');
        if (await s.count()) {
          await s.fill('@artem');
          await page.waitForTimeout(1200);
          const hit = page.locator('[data-testid^="handle-"]').first();
          if (await hit.count()) { await hit.click(); await page.waitForTimeout(600); }
          await shot(`w_${kind}_03_parties_filled`);
        }
      } else if (step === 'details') {
        await shot(`w_${kind}_04_details`);
        await fillVisibleFields();
        await shot(`w_${kind}_04_details_filled`);
      } else if (step === 'stages') {
        await shot(`w_${kind}_05_stages`);
        await fillVisibleFields();
        await shot(`w_${kind}_05_stages_filled`);
      } else if (step === 'terms') {
        await shot(`w_${kind}_06_terms`);
        await fillVisibleFields();
        await shot(`w_${kind}_06_terms_filled`);
      } else if (step === 'preview') {
        await shot(`w_${kind}_07_preview`);
        break;
      }
    }
  } catch (e) {
    log(`\n## w_${kind} — XX ${String(e).split('\n')[0]}`);
  }
}

// Актёр-объединение — В КОНЦЕ прохода: переключение зрителя меняет выдачу
// договоров, и запущенные после него сценарии карточек видели чужие данные.
// «Объединение» видно только когда активный актёр — объединение (ADR-129):
// переключаем актёра через шапку, снимаем экран, возвращаем себя обратно.
await go('s02_group', '/me/settings/profile', async () => {
  await page.getByTestId('actor-trigger').click();
  await page.waitForTimeout(400);
  const g = page.locator('[data-testid^="actor-group-"]').first();
  if (!(await g.count())) throw new Error('нет объединений в переключателе');
  await g.click();
  await page.waitForTimeout(900);
  await page.goto(`${BASE}/me/settings/group`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1400);
});
await go('s02b_dashboard_group_actor', '/');
await go('s02c_groups_as_group', '/groups');
// возврат к личному актёру (только если блок актёра вообще выполнялся)
try {
  if (ONLY && !ONLY.test('s02_group')) throw new Error('пропущено фильтром ONLY');
  await page.getByTestId('actor-trigger').click({ timeout: 5000 });
  await page.waitForTimeout(400);
  await page.locator('[data-testid^="actor-option-"]:not([data-testid="actor-option-add-org"])').first().click();
  await page.waitForTimeout(900);
} catch (e) {
  log(`\n## возврат к личному актёру — XX ${String(e).split('\n')[0]}`);
}

log(`\n=== экранов снято: ${count}`);
writeFileSync(`${OUT}/report.txt`, lines.join('\n'));
await browser.close();
console.log(`=== отчёт: ${OUT}/report.txt`);
