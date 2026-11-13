import { test, expect, type Page } from '@playwright/test';

/**
 * DEV-16 §1 ⭐ — «вёрстка не ломается на псевдолокали с длинными строками (en-XA-подобный
 * тест)». Псевдолокаль — `packages/i18n/src/pseudo.ts` (каждая строка на ~35% длиннее,
 * в квадратных скобках), включается e2e-хуком `window.__mockDebug.setPseudoLocale()`
 * (не выбираема обычным переключателем — нет в /v1/locales).
 *
 * Проверка — нет горизонтального переполнения (`scrollWidth` > `clientWidth` у `<html>`)
 * на нескольких контентных экранах разной плотности. Точечный текстовый оверфлоу внутри
 * отдельных строк (обрезание по `text-overflow: ellipsis`) — намеренно ДОПУСТИМ (это и
 * есть защита от переполнения на длинных строках, не баг) — здесь проверяем именно
 * ГОРИЗОНТАЛЬНЫЙ СКРОЛЛ СТРАНИЦЫ, который ellipsis не даёт, а поломанная вёрстка — даёт.
 *
 * `locale: 'en-US'` — см. комментарий в auth-onboarding.spec.ts/language-switcher.spec.ts:
 * тексты ниже («Continue with Google», «Settings») — английские, глобальный ru-RU-дефолт
 * здесь не подходит.
 */
test.use({ locale: 'en-US' });

async function enablePseudoLocale(page: Page): Promise<void> {
  await page.waitForFunction(() => Boolean((window as unknown as { __mockDebug?: unknown }).__mockDebug));
  // Дождаться, пока useLocaleResolution (DEV-16a §3) один раз разрешит реальный язык
  // гостя (лендинг ru → en по navigator.language) — иначе его эффект может сработать
  // ПОСЛЕ нашего переключения на псевдолокаль (напр. когда /v1/locales ещё грузился)
  // и затереть en-XA обратно на en.
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  // Одного `lang="en"` для этого НЕ достаточно: useHtmlLangDir ставит атрибут из
  // i18n.language сразу на монтировании, а useLocaleResolution доразрешает язык
  // асинхронно — ждёт GET /v1/locales, а затем `await applyLocale` с ленивой
  // подгрузкой неймспейсов. На ХОЛОДНОМ первом заходе (первый тест файла, чанки и
  // словари ещё не в кеше preview-сервера) этот await приземляется ПОСЛЕ нашего
  // переключения и возвращает en-XA обратно на en. Наблюдается ровно так: первый
  // прогон падал (7.4 с в таймауте), повторы 2 и 3 в том же файле проходили за
  // ~400 мс. Продукта это не касается — обычное переключение языка идёт через
  // LanguageSwitcher, который пишет выбор в guestLocale, и повторный проход
  // эффекта разрешает ТОТ ЖЕ код; мимо стора ходит только этот отладочный хук.
  // Поэтому переключаем с повтором: применяем и проверяем, что язык УДЕРЖАЛСЯ.
  await expect(async () => {
    await page.evaluate(() => {
      (window as unknown as { __mockDebug: { setPseudoLocale: () => void } }).__mockDebug.setPseudoLocale();
    });
    await page.waitForTimeout(200); // дать позднему applyLocale шанс затереть
    await expect(page.locator('html')).toHaveAttribute('lang', 'en-XA', { timeout: 1_000 });
  }).toPass({ timeout: 15_000 });
}

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1); // 1px — округление суб-пиксельного рендера
}

test('WelcomePage (герой + форма) — без горизонтального скролла на псевдолокали', async ({ page }) => {
  await page.goto('/welcome');
  await enablePseudoLocale(page); // внутри — проверка, что язык переключился и удержался
  await expectNoHorizontalOverflow(page);
});

test('LanguageSwitcher: список языков (само-названия + beta-бейджи) — без переполнения', async ({ page }) => {
  await page.goto('/welcome');
  await enablePseudoLocale(page);
  await page.getByRole('button', { name: /\[.*\]/ }).first().click(); // chip-триггер тоже псевдолокализован
  await expect(page.getByRole('listbox')).toBeVisible();
  await expectNoHorizontalOverflow(page);
});

test('Settings (плотные строки настроек) — без горизонтального скролла на псевдолокали', async ({ page }) => {
  await page.goto('/welcome');
  await page.getByRole('button', { name: 'Continue with Google' }).click();
  await page.getByTestId('google-mock-sub-existing-1').click();
  await expect(page).toHaveURL(/\/$/, { timeout: 10_000 });
  await page.locator('a[href="/me"]').first().click();
  await page.getByText('Settings').click();
  await enablePseudoLocale(page);
  await expectNoHorizontalOverflow(page);
});
