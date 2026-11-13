import { test, expect, type Locator, type Page } from '@playwright/test';

/**
 * Мобильный проход по карточке разногласия (замечания владельца 05.09,
 * живой прогон на Samsung S22 Ultra).
 *
 * Проверяем ровно две вещи, из-за которых поле пояснений «не выдавалось»:
 * окно действий на узком экране — нижний шит с ПРОКРУЧИВАЕМЫМ телом, и
 * панель кнопок не рисуется поверх формы, когда экранная клавиатура
 * съедает высоту (в браузере это тот же случай, что уменьшение вьюпорта).
 * Плюс лента «Что зафиксировано»: вложение должно открываться.
 */
const PHONE = { width: 360, height: 740 };
/** Высота с поднятой клавиатурой — примерно столько остаётся на S22 Ultra. */
const PHONE_KEYBOARD = { width: 360, height: 420 };
/** Каталог скриншотов — из окружения (по умолчанию `web/test-results/…`,
 *  который уже игнорируется git). */
const SHOTS = process.env.PW_SHOTS ?? 'test-results/disputes-mobile-0905';

test.use({ viewport: PHONE });

async function login(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Номер телефона').fill('+7 900 123-45-67');
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Получить код' }).click();
  await page.getByLabel('Код подтверждения').fill('111111');
  await page.getByRole('button', { name: 'Войти' }).click();
  await expect(page).toHaveURL(/\/$/, { timeout: 10_000 });
}

/** Снимок ПОСЛЕ анимации подложки: иначе кадр ловит полупрозрачный overlay. */
async function shot(page: Page, name: string, fullPage = false): Promise<void> {
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage });
}

async function openPath(page: Page, path: string): Promise<void> {
  await page.evaluate((p) => {
    window.history.pushState({}, '', p);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, path);
}

/** Панель кнопок окна не должна перекрывать поле: до фикса она была
 * `position: sticky` ВНУТРИ прокрутки и рисовалась поверх формы. */
async function expectNotCoveredByActions(page: Page, field: Locator): Promise<void> {
  const fieldBox = await field.boundingBox();
  const actionsBox = await page.locator('[role="dialog"] > *:last-child').boundingBox();
  expect(fieldBox, 'у поля нет геометрии').not.toBeNull();
  expect(actionsBox, 'у панели действий нет геометрии').not.toBeNull();
  expect(fieldBox!.y + fieldBox!.height, 'панель действий накрывает поле').toBeLessThanOrEqual(actionsBox!.y + 1);
}

test('окно «Ответить» на 360: поле пояснений видно и не уходит под кнопки', async ({ page }) => {
  await login(page);
  await openPath(page, '/disputes/dsp-open-1');
  await expect(page.getByTestId('dispute-page')).toBeVisible();

  await page.getByTestId('dispute-respond').click();
  const comment = page.getByTestId('dispute-respond-comment');
  await expect(comment).toBeVisible();
  await shot(page, 'respond-360');

  const box = await comment.boundingBox();
  expect(box, 'у поля комментария нет геометрии').not.toBeNull();
  expect(box!.y + box!.height, 'поле комментария уходит за нижнюю кромку').toBeLessThanOrEqual(PHONE.height);
  await expect(page.getByTestId('dispute-respond-submit')).toBeInViewport();
  await expectNotCoveredByActions(page, comment);

  // Клавиатура: высоты остаётся треть — поле обязано остаться на виду.
  await comment.click();
  await page.setViewportSize(PHONE_KEYBOARD);
  await expect(comment).toBeInViewport();
  await shot(page, 'respond-360-keyboard');
  await expectNotCoveredByActions(page, comment);
});

test('окно возражения на 360: поле комментария на виду при поднятой клавиатуре', async ({ page }) => {
  await login(page);
  await openPath(page, '/disputes/dsp-open-1');
  await page.getByTestId('contest-window-dw-open-1').click();
  const comment = page.getByTestId('contest-comment');
  await expect(comment).toBeVisible();
  await shot(page, 'contest-360');

  await comment.click();
  await page.setViewportSize(PHONE_KEYBOARD);
  await expect(comment).toBeInViewport();
  await shot(page, 'contest-360-keyboard');
  await expectNotCoveredByActions(page, comment);
});

test('окно «Предложить скидку» на 360: оговорка предзаполнена и достижима', async ({ page }) => {
  await login(page);
  // Скидку предлагает заказчик спорного листа — в моке это вторая персона.
  await openPath(page, '/disputes/dsp-fix-2of2');
  await expect(page.getByTestId('dispute-page')).toBeVisible();
  // Кнопка появляется, когда дотянется сумма спорного листа (второй запрос).
  const open = page.getByTestId('dispute-propose-discount');
  await expect(open).toBeVisible();
  await open.click();
  const antiWaiver = page.getByTestId('dispute-discount-anti-waiver');
  await expect(antiWaiver).toHaveValue(/Скидка закрывает только указанный дефект/);
  await shot(page, 'discount-360');
  await expect(page.getByTestId('dispute-discount-submit')).toBeInViewport();
});

test('лента спора: вложение открывается просмотрщиком со «Скачать»', async ({ page }) => {
  await login(page);
  await openPath(page, '/disputes/dsp-open-1');
  const feed = page.getByTestId('dispute-feed');
  await expect(feed).toBeVisible();
  await shot(page, 'feed-360', true);

  const thumb = feed.getByTestId('dispute-feed-thumb').first();
  await expect(thumb).toBeVisible();
  await thumb.click();
  await expect(page.getByTestId('photo-viewer-download')).toBeVisible();
  await shot(page, 'feed-viewer-360');
});
