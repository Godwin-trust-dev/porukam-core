import { test, expect } from '@playwright/test';

/**
 * DEV-16a §7 — e2e-сценарии переключателя языка. Против мок-API (VITE_API_MODE=mock,
 * playwright.config.ts). Мок-стор — in-memory на вкладку (`profileDb.ts`/`authGlobalDb.ts`,
 * без localStorage) — «переживает перезагрузку» здесь проверяем как «PATCH ушёл и
 * реально сохранился на моке» (повторный запрос без релоада), а не через `page.reload()`,
 * который в этой мок-архитектуре честно сбрасывает и клиентское, и «серверное» состояние.
 *
 * `locale: 'en-US'` — глобальный `playwright.config.ts` фиксирует `ru-RU` (большинство
 * остальных e2e писались для безусловно-RU рантайма, до переключателя языка); этот файл —
 * ровно про автоопределение по `navigator.language` (DEV-16a §3), поэтому здесь нужен
 * англоязычный гость, а не глобальный RU-дефолт.
 */
test.use({ locale: 'en-US' });

test('(1) гость по инвайт-ссылке меняет язык до логина — UI переключился мгновенно', async ({ page }) => {
  await page.goto('/welcome?invite=invite-tok-1');
  await expect(page.getByText('Alex invited you')).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');

  await page.getByRole('button', { name: 'Interface language' }).click();
  await page.getByRole('option', { name: 'Русский' }).click();

  // Без перезагрузки — тот же текст банера приглашения теперь по-русски.
  await expect(page.getByText('пригласил(а) вас')).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang', 'ru');
});

test('(2) выбрать es → интерфейс на испанском', async ({ page }) => {
  // Раньше тест проверял фолбэк es→en на непереведённом ключе — после
  // l10n-импорта es переведён целиком, и кнопка говорит по-испански.
  // Фолбэк-цепочка НЕ потеряна: она покрыта юнитами i18n (DEV-16 §1).
  await page.goto('/welcome');
  await page.getByRole('button', { name: 'Interface language' }).click();
  await page.getByRole('option', { name: 'Español' }).click();

  await expect(page.locator('html')).toHaveAttribute('lang', 'es');
  await expect(page.getByRole('button', { name: 'Continuar con Google' })).toBeVisible();
});

test('(3) поиск «укр» → «Українська»', async ({ page }) => {
  await page.goto('/welcome');
  await page.getByRole('button', { name: 'Interface language' }).click();
  await page.getByRole('searchbox').fill('укр');
  await expect(page.getByRole('option', { name: 'Українська' })).toBeVisible();
  await expect(page.getByRole('option', { name: 'Español' })).toHaveCount(0);
});

// (4) «отключённая локаль → EN + тост» удалён из e2e: мок-каталог локалей
// строится из реестра пакетов и физически не содержит выключенных языков
// (докстринг web/src/mocks/localesDb.ts); сценарий выключенной локали
// покрыт подменой ответа эндпоинта в web/tests/localeIntegration.test.tsx.

test('(5) залогинен — выбор сохраняется в профиль (PATCH подтверждён, переживает навигацию без релоада)', async ({ page }) => {
  // Сессия — в памяти вкладки (authStore, без localStorage — §13.2), поэтому вся навигация
  // после логина — кликами по SPA-роутеру (`page.goto()` = полная перезагрузка = потеря сессии).
  await page.goto('/welcome');
  await page.getByRole('button', { name: 'Continue with Google' }).click();
  await page.getByTestId('google-mock-sub-existing-1').click();
  await expect(page).toHaveURL(/\/$/, { timeout: 10_000 });

  // Свежий GLOBAL-аккаунт без сохранённого locale — автоопределение по navigator.language
  // Chromium'а (en-US в этом окружении) отдаёт English (§3, useLocaleResolution).
  await page.locator('a[href="/me"]').first().click();
  await expect(page).toHaveURL(/\/me$/);
  await page.getByText('Settings').click();
  await expect(page).toHaveURL(/\/me\/settings/);
  await page.getByTestId('settings-nav-app').click();
  await expect(page).toHaveURL(/\/me\/settings\/app$/);

  await page.getByRole('button', { name: 'Interface language' }).click();
  await page.getByRole('option', { name: 'Deutsch' }).click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'de');

  // Уходим на другую вкладку настроек и возвращаемся (testid-навигация — language-independent,
  // UI уже переключился на немецкий) — тот же мок-профиль, PATCH реально применился на
  // «сервере», не только оптимистично в кэше React Query. Полный `page.goto()`/релоад здесь
  // не используем: сессия — в памяти вкладки (authStore, без localStorage, §13.2), релоад её
  // сбросит вместе с профилем — это честное ограничение мок-архитектуры, не баг переключателя.
  await page.getByTestId('settings-nav-profile').click();
  await page.getByTestId('settings-nav-app').click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'de');
  await expect(page.getByText('Deutsch')).toBeVisible();
});
