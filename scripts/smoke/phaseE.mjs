// §E-смоук на 2 аккаунта против реального бэка: создать (мастер) → подписать
// (2-шаг) → этап с реальным фото (multipart) → приёмка → репутация.
// Ограничение Ф1: authStore в памяти — весь флоу аккаунта в одной вкладке,
// только клиентская навигация. Логин-шим: /auth/otp/request отдаёт 200 БЕЗ
// тела — фронт падает на res.dev_hint (БАГ, в отчёт); подменяем тело на '{}'.
import { launch, snap, dump } from './lib.mjs';

const RUN = process.env.RUN_ID ?? 'e1';
const CUST_PHONE = `+7999132${RUN.padStart(4, '0').slice(-4)}1`;
const MAST_PHONE = `+7999132${RUN.padStart(4, '0').slice(-4)}2`;
const CUST_HANDLE = `smokecust${RUN}`;
const MAST_HANDLE = `smokemast${RUN}`;
const PHOTO = process.env.SMOKE_PHOTO ?? 'web/public/icons/icon-512.png';
const API = 'http://127.0.0.1:8000/v1';

let step = 'init';
const S = (name) => { step = name; console.log(`--- ${name}`); };

const TOKENS = {};

async function apiSetupHandle(phone, handle) {
  await fetch(`${API}/auth/otp/request`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone }) });
  const verify = await fetch(`${API}/auth/otp/verify`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone, code: '111111' }) });
  if (!verify.ok) throw new Error(`verify ${phone}: ${verify.status} ${await verify.text()}`);
  const tokens = await verify.json();
  // шаг «Данные и приватность» — без него у пользователя нет Profile и он
  // не резолвится контрагентом (counterparty_not_found)
  const pc = await fetch(`${API}/users/me/privacy-consents`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokens.access}` }, body: JSON.stringify({ pd_processing: true, profile_public: false, phone_discoverability: false }) });
  if (!pc.ok) throw new Error(`privacy ${phone}: ${pc.status} ${await pc.text()}`);
  const put = await fetch(`${API}/users/me/handle`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokens.access}` }, body: JSON.stringify({ value: handle }) });
  if (!put.ok && put.status !== 409) throw new Error(`handle ${handle}: ${put.status} ${await put.text()}`);
  // Profile создаётся асинхронно (outbox -> apps.profiles.subscriber):
  // дождаться материализации, иначе контрагент не резолвится (404)
  for (let i = 0; i < 30; i++) {
    const me = await (await fetch(`${API}/users/me`, { headers: { Authorization: `Bearer ${tokens.access}` } })).json();
    if ((me.profiles ?? []).length > 0) break;
    await new Promise((r) => setTimeout(r, 1000));
    if (i === 29) throw new Error(`profile ${handle} не материализовался за 30с`);
  }
  console.log(`setup: ${phone} -> @${handle} (${put.status}), профиль есть`);
  TOKENS[handle] = tokens.access;
}

function shimOtp(page) {
  return page.route('**/v1/auth/otp/request', async (route) => {
    const res = await route.fetch();
    if (res.status() === 200) return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    return route.fulfill({ response: res });
  });
}

async function uiLogin(page, phone) {
  await page.goto('/login');
  await page.getByRole('textbox').first().fill(phone);
  await page.getByRole('checkbox').first().check();
  await page.getByRole('button', { name: /получить код/i }).click();
  await page.getByRole('button', { name: /войти/i }).waitFor({ timeout: 10000 });
  await page.getByRole('textbox').first().fill('111111');
  await page.getByRole('button', { name: /войти/i }).click();
  await page.waitForURL('/', { timeout: 15000 });
}


async function signSide(page) {
  // 2-шаговое подписание (ADR-088 Фаза 4): маршрутизация подписанта -> подпись.
  // CTA может появиться с задержкой (профиль актёра приезжает поллингом) —
  // ждём циклом до 30с.
  for (let i = 0; i < 30; i++) {
    const route = page.getByTestId('route-signatory-cta');
    if (await route.isVisible().catch(() => false)) await route.click().catch(() => {});
    const sign = page.getByTestId('sign-cta');
    if (await sign.isVisible().catch(() => false)) {
      await sign.click();
      await page.waitForTimeout(2000);
      return;
    }
    await page.waitForTimeout(1000);
  }
  throw new Error('sign-cta не появился за 30с');
}

const cust = await launch();
const mast = await launch();
cust.page.on('response', async (r) => {
  const u = new URL(r.url());
  if (u.pathname === '/v1/users/me' || /^\/v1\/contracts\/[0-9a-f-]{36}$/.test(u.pathname)) {
    console.log('[cust body]', u.pathname, (await r.text().catch(() => '')).slice(0, 400));
  }
});
mast.page.on('response', async (r) => {
  const u = new URL(r.url());
  if (u.pathname === '/v1/contracts' || u.pathname === '/v1/users/me') {
    const h = r.request().headers();
    console.log('[mast body]', u.pathname, 'acting=' + (h['x-acting-profile'] ?? '-'), (await r.text().catch(() => '')).slice(0, 300));
  }
});
for (const [tag, ctx] of [['cust', cust], ['mast', mast]]) {
  ctx.page.on('console', (m) => { if (m.type() === 'error') console.log(`[${tag}] console.error:`, m.text().slice(0, 160)); });
  ctx.page.on('pageerror', (e) => console.log(`[${tag}] pageerror:`, e.message, '|', (e.stack ?? '').split('\n').slice(1, 3).join(' ')));
  ctx.page.on('response', async (r) => {
    if (r.url().includes('/v1/') && r.status() >= 400) {
      const body = await r.text().catch(() => '');
      const req = r.request().postData() ?? '';
      console.log(`[${tag}] HTTP ${r.status()} ${r.request().method()} ${new URL(r.url()).pathname}\n  req: ${req.slice(0, 300)}\n  res: ${body.slice(0, 300)}`);
    }
  });
}

try {
  S('setup: хендлы через API');
  await apiSetupHandle(CUST_PHONE, CUST_HANDLE);
  await apiSetupHandle(MAST_PHONE, MAST_HANDLE);

  S('cust: UI-логин');
  await uiLogin(cust.page, CUST_PHONE);
  await snap(cust.page, 'e-01-cust-dashboard');

  S('mast: UI-логин');
  await uiLogin(mast.page, MAST_PHONE);

  S('cust: мастер — тип/сфера');
  const p = cust.page;
  await p.getByRole('link', { name: /сделки/i }).first().click();
  await p.waitForURL(/\/contracts$/);
  await p.getByTestId('create-contract').click();
  await p.waitForURL(/\/contracts\/new\/type/);
  await p.getByTestId('type-service').click();
  await p.getByTestId('wizard-next').click();
  await p.waitForURL(/\/sphere/);
  await p.getByTestId('sphere-search').fill('Ремонт');
  await p.getByTestId('sphere-renovation').first().click();
  await p.getByTestId('wizard-next').click();

  S('cust: мастер — стороны (создание черновика)');
  await p.waitForURL(/\/parties/);
  await p.getByTestId('counterparty-search').fill(`@${MAST_HANDLE}`);
  await p.getByTestId(`handle-@${MAST_HANDLE}`).click();
  await p.getByTestId('wizard-next').click();

  S('cust: мастер — суть');
  await p.waitForURL(/\/details/);
  await p.getByTestId('contract-title').fill('Ремонт кухни — смоук §E');
  await p.getByTestId('work-description').fill('Демонтаж, стяжка, укладка плитки');
  await p.getByTestId('location-address').fill('Москва, ул. Строителей, 5');
  await p.getByTestId('start-date').fill('2026-09-01');
  await p.getByTestId('end-date').fill('2026-09-30');
  await p.getByTestId('wizard-next').click();

  S('cust: мастер — этапы');
  await p.waitForURL(/\/stages/);
  await p.getByTestId('add-stage').click();
  await p.getByTestId('total-cost').fill('25000');
  await p.getByTestId('wizard-next').click();

  S('cust: мастер — условия и превью');
  await p.waitForURL(/\/terms/);
  // способ оплаты теперь выбирается В МАСТЕРЕ (feat/web-wizard-payment-method)
  await p.getByTestId('payment-method-select').selectOption('cash');
  await p.getByTestId('wizard-next').click();
  await p.waitForURL(/\/preview/);
  await snap(p, 'e-02-cust-preview');
  await p.getByTestId('send-for-review').click();
  await p.waitForURL(/\/contracts\/[0-9a-f-]{36}/, { timeout: 15000 });
  const contractId = p.url().match(/contracts\/([0-9a-f-]{36})/)[1];
  console.log('contract:', contractId);
  await snap(p, 'e-03-cust-contract-sent');


  S('cust: заморозка и подпись со стороны заказчика');
  await p.getByTestId('go-to-signing-screen').click().catch(async () => {
    await snap(p, 'e-03b-no-signing-link'); await dump(p); throw new Error('нет go-to-signing-screen');
  });
  await p.waitForURL(/\/sign/);
  const freeze = p.getByTestId('freeze-cta');
  if (await freeze.isVisible().catch(() => false)) await freeze.click();
  await snap(p, 'e-04-cust-signing');
  await signSide(p);
  await snap(p, 'e-05-cust-signed');

  S('mast: открыть договор и подписать');
  const m = mast.page;
  await m.getByRole('link', { name: /сделки/i }).first().click();
  await m.waitForURL(/\/contracts$/);
  // список закэширован (staleTime 30с) с момента ДО создания сделки —
  // ремаунтим страницу, пока строка не появится
  let opened = false;
  for (let i = 0; i < 20; i++) {
    const row = m.getByText('Ремонт кухни — смоук §E').first();
    if (await row.isVisible().catch(() => false)) { await row.click(); opened = true; break; }
    await m.waitForTimeout(3000);
    await m.getByRole('link', { name: /лента/i }).first().click();
    await m.getByRole('link', { name: /сделки/i }).first().click();
    await m.waitForURL(/\/contracts$/).catch(() => {});
  }
  if (!opened) throw new Error('сделка не появилась в списке mast за 60с');
  // DEV-19: на ≥1024 клик по строке ВЫБИРАЕТ сделку (`?sel=`) и раскрывает
  // панель справа — в карточку ведёт «Полная карточка» (pane-full-card).
  const fullCard = m.getByTestId('pane-full-card');
  if (await fullCard.waitFor({ timeout: 10000 }).then(() => true, () => false)) await fullCard.click();
  await m.waitForURL(new RegExp(`/contracts/${contractId}`), { timeout: 15000 });
  await m.getByTestId('go-to-signing-screen').click();
  await m.waitForURL(/\/sign/);
  await signSide(m);
  await snap(m, 'e-06-mast-signed-ceremony');

  S('mast: этап — старт');
  await m.goBack();
  await m.waitForURL(new RegExp(`/contracts/${contractId}`));
  await snap(m, 'e-07-mast-contract-signed');
  // UI-перехода на страницу этапа с реальной карточки НЕТ (доводка из плана:
  // attention-карточки дашборда -> реальные Stage/Acceptance страницы).
  // Навигируем клиентски (popstate, без перезагрузки — authStore в памяти).
  const tree = await (await fetch(`http://127.0.0.1:8000/v1/contracts/${contractId}/milestones`, { headers: { Authorization: `Bearer ${TOKENS[MAST_HANDLE]}` } })).json();
  const leafId = tree[0].id;
  console.log('leaf milestone:', leafId);
  await m.evaluate((url) => { window.history.pushState({}, '', url); window.dispatchEvent(new PopStateEvent('popstate')); }, `/contracts/${contractId}/stages/${leafId}`);
  await m.waitForTimeout(2000);
  await m.getByTestId('start-stage-cta').click();
  await m.waitForTimeout(1500);
  await snap(m, 'e-08-mast-stage-started');

  S('mast: фото + сдача этапа');
  await m.getByTestId('evidence-uploader').locator('input[type=file]').setInputFiles(PHOTO);
  await m.waitForTimeout(2500);
  await snap(m, 'e-09-mast-evidence');
  await m.getByTestId('submit-stage-cta').click();
  await m.getByTestId('confirm-submit-stage').click();
  await m.waitForTimeout(2000);
  const later = m.getByTestId('drive-prompt-later');
  if (await later.isVisible().catch(() => false)) await later.click();
  await snap(m, 'e-10-mast-submitted');

  S('cust: приёмка');
  await p.evaluate((url) => { window.history.pushState({}, '', url); window.dispatchEvent(new PopStateEvent('popstate')); }, `/contracts/${contractId}/stages/${leafId}`);
  await p.waitForTimeout(2000);
  await p.getByTestId('accept-milestone-cta').click();
  await p.getByTestId('confirm-submit-stage').click();
  await p.waitForTimeout(2500);
  await snap(p, 'e-11-cust-accepted');

  S('репутация исполнителя (публичная карточка)');
  const pub = await launch();
  await pub.page.goto(`/@${MAST_HANDLE}`);
  await pub.page.waitForTimeout(3500); // relay outbox → репутация асинхронно
  await pub.page.reload();
  await pub.page.waitForTimeout(1500);
  await snap(pub.page, 'e-12-reputation-card');
  await pub.browser.close();

  console.log('SMOKE OK');
} catch (e) {
  console.log(`FAIL at [${step}]: ${e.message.split('\n')[0]}`);
  await snap(cust.page, 'fail-cust').catch(() => {});
  await snap(mast.page, 'fail-mast').catch(() => {});
  console.log('--- dump cust:'); await dump(cust.page).catch(() => {});
  console.log('--- dump mast:'); await dump(mast.page).catch(() => {});
  process.exitCode = 1;
} finally {
  await cust.browser.close();
  await mast.browser.close();
}
