// Общий драйвер §E-смоука: chromium против http://127.0.0.1:8080 (real API).
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

export const BASE = 'http://127.0.0.1:8080';
export const SHOTS = process.env.SMOKE_SHOTS ?? 'scripts/smoke/shots';
mkdirSync(SHOTS, { recursive: true });

export async function launch(storageState) {
  const browser = await chromium.launch();
  const context = await browser.newContext({
    baseURL: BASE,
    locale: 'ru-RU',
    viewport: { width: 1280, height: 900 },
    ...(storageState ? { storageState } : {}),
  });
  const page = await context.newPage();
  return { browser, context, page };
}

export async function snap(page, name) {
  await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: false });
  console.log(`snap ${name} url=${page.url()}`);
}

// При спорном состоянии — перечень интерактивных элементов, чтобы не гадать селекторы.
export async function dump(page) {
  const roles = ['button', 'link', 'textbox', 'checkbox', 'radio', 'combobox', 'tab'];
  for (const role of roles) {
    const els = await page.getByRole(role).all();
    for (const el of els) {
      const name = (await el.evaluate((n) => n.getAttribute('aria-label') || n.textContent?.trim() || n.getAttribute('placeholder') || '')).slice(0, 80);
      const vis = await el.isVisible().catch(() => false);
      if (vis) console.log(`  [${role}] ${name}`);
    }
  }
  const testids = await page.locator('[data-testid]').all();
  for (const el of testids) {
    const id = await el.getAttribute('data-testid');
    if (await el.isVisible().catch(() => false)) console.log(`  [testid] ${id}`);
  }
}

export async function login(page, phone) {
  await page.goto('/login');
  await page.getByRole('textbox').first().fill(phone);
  const consent = page.getByRole('checkbox');
  if (await consent.count()) await consent.first().check();
  await page.getByRole('button', { name: /получить код/i }).click();
  await page.getByRole('textbox').first().waitFor({ timeout: 10000 });
  await page.getByRole('textbox').first().fill('111111');
  await page.getByRole('button', { name: /войти/i }).click();
  await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 15000 });
}
