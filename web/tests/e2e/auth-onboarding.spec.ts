import { test, expect } from '@playwright/test';

/**
 * Playwright — GLOBAL У1, вход через Google + онбординг (DEV-auth-onboarding
 * §11). Google — мок-заглушка (`/auth/google/mock`, персоны по фикс. sub) —
 * реального accounts.google.com в Ф1–Ф5 нет (web/CLAUDE.md §3).
 *
 * `locale: 'en-US'` — глобальный `playwright.config.ts` фиксирует `ru-RU` (см. комментарий
 * там). `WelcomePage` раньше был принудительно на `en` (`useForceLocale`), теперь на нём
 * есть переключатель языка (DEV-16a) и язык гостя определяется по `navigator.language` —
 * этот файл специально проверяет англоязычный GLOBAL-флоу (тексты ниже — английские), так
 * что явно переопределяем локаль браузера, а не полагаемся на глобальный RU-дефолт.
 */
test.use({ locale: 'en-US' });

test('холодный: Google → согласия → профиль(@handle) → бэкап «Later» → пустой дашборд → «Create your first contract»', async ({ page }) => {
  await page.goto('/welcome');
  await expect(page.getByRole('button', { name: 'Continue with Google' })).toBeVisible();
  // Телефона/пароля нигде нет на входе (§11, тест 5).
  await expect(page.getByLabel(/phone/i)).toHaveCount(0);
  await expect(page.getByLabel(/password/i)).toHaveCount(0);

  await page.getByRole('button', { name: 'Continue with Google' }).click();
  await expect(page).toHaveURL(/\/auth\/google\/mock/);
  await page.getByTestId('google-mock-sub-cold-1').click();

  // Согласия: «Continue» недоступна без обоих обязательных + видимости (§11, тест 3).
  await expect(page).toHaveURL(/\/onboarding\/consents/, { timeout: 10_000 });
  const continueBtn = page.getByRole('button', { name: 'Continue' });
  await expect(continueBtn).toBeDisabled();
  const agree = page.getByRole('checkbox', { name: 'I agree' });
  await agree.nth(0).check();
  await expect(continueBtn).toBeDisabled();
  await page.getByText('Public profile').click();
  await expect(continueBtn).toBeDisabled();
  await agree.nth(1).check();
  await expect(continueBtn).toBeEnabled();
  await continueBtn.click();

  // Профиль: @handle обязателен.
  await expect(page).toHaveURL(/\/onboarding\/profile/, { timeout: 10_000 });
  const handleInput = page.getByRole('textbox', { name: '@handle' });
  await handleInput.fill('coldpathuser1');
  await expect(page.getByText('Available')).toBeVisible({ timeout: 3000 });
  await page.getByRole('button', { name: 'Continue' }).click();

  // Бэкап — опционален, «Later» не блокирует.
  await expect(page).toHaveURL(/\/onboarding\/backup/, { timeout: 10_000 });
  await page.getByRole('button', { name: 'Later' }).click();

  // Финал → пустой дашборд, свежесть видна честно, есть CTA создания первого договора.
  await expect(page).toHaveURL(/\/$/, { timeout: 10_000 });
  await expect(page.getByTestId('fresh-profile-card')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Create your first contract' })).toBeVisible();
});

test('по приглашению: Google → согласия/профиль → сразу на присланный договор', async ({ page }) => {
  await page.goto('/welcome?invite=invite-tok-1');
  await expect(page.getByText('Alex invited you')).toBeVisible();

  await page.getByRole('button', { name: 'Sign in and open the contract' }).click();
  await expect(page).toHaveURL(/\/auth\/google\/mock/);
  await page.getByTestId('google-mock-sub-invite-1').click();

  await expect(page).toHaveURL(/\/onboarding\/consents/, { timeout: 10_000 });
  const agree = page.getByRole('checkbox', { name: 'I agree' });
  await agree.nth(0).check();
  await page.getByText('Only by link and in deals').click();
  await agree.nth(1).check();
  await page.getByRole('button', { name: 'Continue' }).click();

  await expect(page).toHaveURL(/\/onboarding\/profile/, { timeout: 10_000 });
  await page.getByRole('textbox', { name: '@handle' }).fill('invitepathuser1');
  await expect(page.getByText('Available')).toBeVisible({ timeout: 3000 });
  await page.getByRole('button', { name: 'Continue' }).click();

  await expect(page).toHaveURL(/\/onboarding\/backup/, { timeout: 10_000 });
  await page.getByRole('button', { name: 'Later' }).click();

  // Прямиком на присланный договор, минуя пустой дашборд.
  await expect(page).toHaveURL(/\/contracts\/c-3001/, { timeout: 10_000 });
});

test('существующий пользователь → сразу внутрь, минуя онбординг', async ({ page }) => {
  await page.goto('/welcome');
  await page.getByRole('button', { name: 'Continue with Google' }).click();
  await page.getByTestId('google-mock-sub-existing-1').click();
  await expect(page).toHaveURL(/\/$/, { timeout: 10_000 });
});

test('отказ доступа Google → понятная ошибка + повтор ведёт на Welcome', async ({ page }) => {
  await page.goto('/welcome');
  await page.getByRole('button', { name: 'Continue with Google' }).click();
  await page.getByTestId('google-mock-deny').click();
  // Роут колбэка — /auth/google/callback (router.tsx); старый паттерн
  // /auth/callback остался от ранней ревизии и после переименования не совпадал.
  await expect(page).toHaveURL(/\/auth\/google\/callback/);
  await expect(page.getByText(/declined Google access/i)).toBeVisible();
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page).toHaveURL(/\/welcome/);
});
