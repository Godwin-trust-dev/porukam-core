import { test, expect } from '@playwright/test';

/**
 * Вход/регистрация по e-mail шестизначным кодом (ADR-168, решение владельца
 * 06.09.2026): пароля нет, magic-link нет — только код из письма.
 *
 * Прямая навигация на `/login/email` (не через '/'): гостя с корня `RequireAuth`
 * уводит на `/welcome`, а почта — второстепенная кнопка уже там. Маршрут
 * самостоятельный и открывается по прямой ссылке (в т.ч. из письма-приглашения).
 */
test('вход по коду из письма → оболочка', async ({ page }) => {
  await page.goto('/login/email');

  await page.getByLabel('Адрес почты').fill('person@example.com');
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Получить код' }).click();

  // Нейтральная формулировка: существование аккаунта не раскрывается.
  await expect(page.getByText(/Если адрес верный/)).toBeVisible();
  await expect(page.getByText(/Тестовый режим/)).toBeVisible();

  await page.getByLabel('Код подтверждения').fill('111111');
  await page.getByRole('button', { name: 'Войти' }).click();

  // Тот же пост-логин путь, что у телефона/Google: дашборд на «/».
  await expect(page).toHaveURL(/\/$/, { timeout: 10_000 });
  await expect(page.getByTestId('dashboard-attention')).toBeVisible();
});

test('неверный код — человеческая ошибка, экран остаётся на шаге кода', async ({ page }) => {
  await page.goto('/login/email');

  await page.getByLabel('Адрес почты').fill('person@example.com');
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Получить код' }).click();

  await page.getByLabel('Код подтверждения').fill('222222');
  await page.getByRole('button', { name: 'Войти' }).click();

  await expect(page.getByText('Неверный код. Проверьте и попробуйте снова.')).toBeVisible();
  await expect(page).toHaveURL(/\/login\/email$/);
});

/** Мобайл 360px (минимальная ширина проекта): форма помещается без горизонтальной прокрутки. */
test.describe('мобильный проход 360px', () => {
  test.use({ viewport: { width: 360, height: 740 } });

  test('оба шага помещаются, кнопки достижимы', async ({ page }) => {
    await page.goto('/login/email');

    await page.getByLabel('Адрес почты').fill('person@example.com');
    await page.getByRole('checkbox').check();
    const send = page.getByRole('button', { name: 'Получить код' });
    await expect(send).toBeVisible();
    await send.click();

    const code = page.getByLabel('Код подтверждения');
    await expect(code).toBeVisible();
    await code.fill('111111');
    await expect(page.getByRole('button', { name: 'Войти' })).toBeVisible();

    // Горизонтальной прокрутки нет — карточка вписалась в 360 CSS-пикселей.
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);
  });
});

/**
 * Выход из аккаунта (замечание владельца 07.09: «У нас нигде нет кнопки
 * "Выйти", чтобы сменить аккаунт»). Проверяем полный круг: вход → меню
 * актёра → «Выйти» → экран приветствия → повторный вход возможен.
 */
test('выход из меню актёра уводит на приветствие, повторный вход возможен', async ({ page }) => {
  await page.goto('/login/email');
  await page.getByLabel('Адрес почты').fill('person@example.com');
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Получить код' }).click();
  await page.getByLabel('Код подтверждения').fill('111111');
  await page.getByRole('button', { name: 'Войти' }).click();
  await expect(page).toHaveURL(/\/$/, { timeout: 10_000 });

  await page.getByTestId('actor-trigger').click();
  await page.getByTestId('logout').click();

  await expect(page).toHaveURL(/\/welcome$/);
  await expect(page.getByRole('button', { name: 'Войти по почте' })).toBeVisible();
  // Шапки оболочки на экране входа быть не должно — сессия действительно снята.
  await expect(page.getByTestId('actor-trigger')).toHaveCount(0);

  // Повторный вход — тем же путём, без перезагрузки страницы.
  await page.getByRole('button', { name: 'Войти по почте' }).click();
  await page.getByLabel('Адрес почты').fill('person@example.com');
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Получить код' }).click();
  await page.getByLabel('Код подтверждения').fill('111111');
  await page.getByRole('button', { name: 'Войти' }).click();
  await expect(page).toHaveURL(/\/$/, { timeout: 10_000 });
  await expect(page.getByTestId('dashboard-attention')).toBeVisible();
});

/** Срок кода подписан явно — отсчёт повторной отправки за него не отвечает. */
test('под полем кода написан срок годности кода', async ({ page }) => {
  await page.goto('/login/email');
  await page.getByLabel('Адрес почты').fill('person@example.com');
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Получить код' }).click();

  await expect(page.getByTestId('email-code-validity')).toContainText('Код действует 15 мин.');
  await expect(page.getByRole('button', { name: /Отправить ещё раз \(через \d+ с\)/ })).toBeVisible();
});
