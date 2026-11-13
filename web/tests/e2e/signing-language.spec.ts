import { test, expect, type Page } from '@playwright/test';

/**
 * DEV-16b §7 — язык договора на экране подписания. Логин — OTP (RU), совпадает с
 * `navigator.language` (playwright.config.ts фиксирует `ru-RU` глобально) — после входа
 * `me.locale === 'ru'` (мок-сид), официальный язык всех демо-договоров всегда `en` →
 * is_cross_language уже true по умолчанию для этих сценариев без доп. переключений.
 */

async function login(page: Page): Promise<void> {
  await page.goto('/login');
  await expect(page).toHaveURL(/\/login/);
  await page.getByLabel('Номер телефона').fill('+7 900 123-45-67');
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Получить код' }).click();
  await page.getByLabel('Код подтверждения').fill('111111');
  await page.getByRole('button', { name: 'Войти' }).click();
  await expect(page).toHaveURL(/\/$/, { timeout: 10_000 });
}

/** Переход без полной перезагрузки — иначе in-memory сессия (токен) сбросится (§13.2 ТЗ). */
async function openPath(page: Page, path: string): Promise<void> {
  await page.evaluate((p) => {
    window.history.pushState({}, '', p);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, path);
}

/** Переключить язык интерфейса через LanguageSwitcher в настройках (DEV-16a) — тот же
 * механизм, что двигает Accept-Language (web/src/shared/activeLocale.ts). */
async function switchLanguage(page: Page, localeName: string): Promise<void> {
  await openPath(page, '/me/settings/app');
  await page.getByRole('button', { name: /Язык интерфейса|Interface language/ }).click();
  await page.getByRole('option', { name: localeName }).click();
}

/** Переключатель «смотреть как контрагент» — карточка договора (ContractDetailPage). */
async function viewAsContractor(page: Page, contractId: string): Promise<void> {
  await openPath(page, `/contracts/${contractId}`);
  await page.getByTestId('viewas-contractor').click();
  await openPath(page, `/contracts/${contractId}/sign`);
}

test('(1) is_cross_language=false (English) → чистый экран, языковых элементов нет', async ({ page }) => {
  await login(page);
  await switchLanguage(page, 'English');
  await openPath(page, '/contracts/c-3003/sign');
  await expect(page.getByTestId('sign-cta')).toBeVisible();
  await expect(page.getByText('auto-translated')).toHaveCount(0);
  await expect(page.getByText(/Official text/)).toHaveCount(0);
});

test('(2) разноязычная → мой язык + «автоперевод» + «Официальный текст — English · показать» → лист EN', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 }); // mobile — «показать» открывает Sheet, не колонки
  await login(page);
  await openPath(page, '/contracts/c-3003/sign');
  await expect(page.getByTestId('sign-cta')).toBeVisible();

  await expect(page.getByText('автоперевод')).toBeVisible();
  const line = page.getByRole('button', { name: /Официальный текст — English/ });
  await expect(line).toHaveAttribute('aria-expanded', 'false');
  await line.click();
  await expect(line).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByRole('dialog', { name: 'Официальный текст (English)' })).toBeVisible();
  await expect(page.getByText(/действует официальный/)).toBeVisible();
});

test('(3) desktop → «показать» открывает две колонки сравнения', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await login(page);
  await openPath(page, '/contracts/c-3003/sign');
  await page.getByRole('button', { name: /Официальный текст — English/ }).click();
  await expect(page.getByText('Ваш язык (автоперевод)')).toBeVisible();
  await expect(page.getByText('Официальный текст (English)')).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0); // desktop — инлайн, не Sheet
});

test('(4) нет перевода на мой язык → официальный текст + тихая подсказка', async ({ page }) => {
  await login(page);
  await switchLanguage(page, 'Español');
  // Дождаться применения языка ДО перехода: смена — асинхронная (ленивые
  // пакеты), иначе экран подписания успевает отрисоваться по-русски.
  await expect(page.locator('html')).toHaveAttribute('lang', 'es');
  await openPath(page, '/contracts/c-3003/sign');
  await expect(page.getByTestId('sign-cta')).toBeVisible();
  // es переведён целиком (l10n-импорт) — подсказка «нет перевода ДОКУМЕНТА»
  // теперь сама по-испански (signing.noRenderNotice), официальный текст — English.
  await expect(page.getByText(/texto oficial \(inglés\)/)).toBeVisible();
  await expect(page.getByText(/Todavía no hay traducción/)).toBeVisible();
});

test('(5) custom_terms — оригинал + метка «текст стороны», «Перевести» неактивна', async ({ page }) => {
  await login(page);
  await openPath(page, '/contracts/c-3006/sign');
  await expect(page.getByTestId('sign-cta')).toBeVisible();
  await expect(page.getByText('Текст стороны')).toBeVisible();
  await expect(page.getByText('не переводится платформой')).toBeVisible();
  await expect(page.getByText(/Tilda/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Перевести (скоро)' })).toBeDisabled();
});

test('(6) итог: hash; строка офиц. текста — только в разноязычной сделке', async ({ page }) => {
  await login(page);
  // c-3004: заказчик уже подписал — подпись исполнителя сразу закрывает договор (ceremony).
  await viewAsContractor(page, 'c-3004');
  await page.getByTestId('sign-cta').click();
  await expect(page.getByText('По рукам!')).toBeVisible();
  await expect(page.getByText('Официальный текст — English').last()).toBeVisible();
});

test('(7) подпись/церемония не сломаны языковым слоем (регресс №05)', async ({ page }) => {
  await login(page);
  await viewAsContractor(page, 'c-3004'); // заказчик уже подписал — исполнителю остаётся одна подпись
  await page.getByTestId('sign-cta').click();
  await expect(page.getByText('По рукам!')).toBeVisible();
  await page.getByRole('button', { name: 'Открыть договор' }).click();
  await expect(page).toHaveURL(/\/contracts\/c-3004$/);
});
