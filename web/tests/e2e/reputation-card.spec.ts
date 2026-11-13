import { test, expect, type Locator } from '@playwright/test';

/**
 * Публичная карточка репутации (DEV-01, критерии приёмки).
 */

test('гость на /@akovalev видит стартовую карточку и CTA, без глубины', async ({ page }) => {
  // Счётчик «198» и кнопка «Скачать приложение» — ло-фай-эпоха DEV-01: мок
  // теперь отдаёт честные факты (1 сделка), а CTA гостя — GLOBAL-вход
  // («или зарегистрироваться…» → /welcome, Задача_feat_web-global-entry §1).
  await page.goto('/@akovalev');
  await expect(page.getByText('Артём Ковалёв')).toBeVisible();
  await expect(page.getByText('Завершённых сделок')).toBeVisible();
  await expect(page.getByRole('button', { name: 'или зарегистрироваться на сайте' })).toBeVisible();
  // «Сферы деятельности» гость видит: это публичный факт карточки (SphereChips
  // рисуются по card.sphere_codes без оглядки на вход), а прячется от гостя
  // ЧИСЛОВАЯ глубина — она под `card.restricted` (ADR-076 §2). Прежнее
  // ожидание «Сфер нет» осталось от ло-фай-эпохи DEV-01, когда секция была
  // частью закрытой части карточки.
  await expect(page.getByTestId('card-spheres')).toBeVisible();
  await expect(page.getByText('Портфолио')).toHaveCount(0);
});

test('авторизованный видит полную карточку: действия и факты сделок вместо гостевого CTA', async ({ page }) => {
  // Сессия живёт только в памяти (Ф1) — жёсткий переход (page.goto) сбросил бы вход,
  // поэтому после логина возвращаемся на карточку клиентским переходом роутера, не reload.
  // Вход — сразу /login: CTA карточки теперь ведёт на GLOBAL-вход (/welcome,
  // Google), телефонной формы там нет. Прежние проверки «Сферы/Портфолио/
  // переключатель роли/зум фото» — ло-фай-эпоха DEV-01: карточка пересобрана
  // на фактах реального API (feat/reputation-card), этих секций в ней нет —
  // «полнота» авторизованного = действия и детализация завершённых сделок.
  await page.goto('/login');
  await page.getByLabel('Номер телефона').fill('+7 900 123-45-67');
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Получить код' }).click();
  await page.getByLabel('Код подтверждения').fill('111111');
  await page.getByRole('button', { name: 'Войти' }).click();
  await expect(page).toHaveURL(/\/$/, { timeout: 10_000 });

  await page.evaluate(() => {
    window.history.pushState({}, '', '/@akovalev');
    window.dispatchEvent(new PopStateEvent('popstate'));
  });
  await expect(page.getByText('Артём Ковалёв')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Предложить сделку' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Написать' })).toBeVisible();
  // Гостевого CTA нет — человек уже внутри.
  await expect(page.getByRole('button', { name: 'или зарегистрироваться на сайте' })).toHaveCount(0);
  // Детализация завершённой сделки с выходом на карточку контрагента.
  await expect(page.getByText('Завершённые сделки')).toBeVisible();
  await expect(page.getByText('Заказчик — открыть карточку')).toBeVisible();
});

test('неизвестный хендл → «нет такой страницы»', async ({ page }) => {
  await page.goto('/@no-such-user-xyz');
  await expect(page.getByText('Такой страницы нет')).toBeVisible();
});

test('гостю полосу предпросмотра не показывают (замечание владельца 05.09)', async ({ page }) => {
  // Полоса «Вы смотрите свою карточку как гость» — режим ВЛАДЕЛЬЦА; на чужой
  // карточке и без сессии её быть не должно.
  await page.goto('/@godwin');
  await expect(page.getByText('Годвин').first()).toBeVisible();
  await expect(page.getByTestId('preview-bar')).toHaveCount(0);

  await page.goto('/@akovalev');
  await expect(page.getByText('Артём Ковалёв')).toBeVisible();
  await expect(page.getByTestId('preview-bar')).toHaveCount(0);
});

/**
 * Дашборд репутации по макету 05.09 (ADR-163) — то, ради чего экран
 * пересобирали: две системы оценки по роли, цветовые зоны и отсутствие
 * горизонтального скролла на 360.
 */
test('гость видит разделы по ролям, но НЕ видит объём и защищённые платежи', async ({ page }) => {
  await page.goto('/@akovalev');
  await expect(page.getByTestId('spheres-contractor')).toBeVisible();
  await expect(page.getByTestId('spheres-customer')).toBeVisible();
  await expect(page.getByTestId('card-reliability')).toBeVisible();
  // ADR-163 §4: объём по валютам и доля защищённых платежей на публичной
  // карточке не показываются ни при какой видимости.
  const body = await page.locator('body').innerText();
  expect(body).not.toMatch(/₽|RUB/);
  expect(body).not.toMatch(/защищённ/i);
});

test('на 360 карточка репутации не даёт горизонтального скролла', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 780 });
  await page.goto('/@akovalev');
  await expect(page.getByTestId('spheres-contractor')).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow, 'карточка репутации на 360 — горизонтальный скролл').toBeLessThanOrEqual(1);
  // Ни один элемент не должен вылезать за правый край (ловит и то, что
  // спрятано `overflow-x: clip` у предка).
  const wide = await page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    return [...document.querySelectorAll('main *')]
      .filter((el) => el.getBoundingClientRect().right > vw + 1)
      .map((el) => el.className)
      .slice(0, 5);
  });
  expect(wide).toEqual([]);
});

test('на 360 порядок карточки: шапка → плитки фактов → сферы по ролям', async ({ page }) => {
  // Регресс к багу 05.09: `.rail`/`.body` — `display: contents`, поэтому
  // прямой ребёнок без явного `order` получал 0 и всплывал ВЫШЕ шапки —
  // «По сферам и ролям» и «Надёжность» рисовались над именем.
  await page.setViewportSize({ width: 360, height: 780 });
  await page.goto('/@akovalev');
  const header = page.getByRole('heading', { level: 1, name: 'Артём Ковалёв' });
  await expect(header).toBeVisible();
  await expect(page.getByTestId('card-stats')).toBeVisible();
  await expect(page.getByTestId('spheres-contractor')).toBeVisible();

  const y = async (locator: Locator) => {
    const box = await locator.boundingBox();
    if (!box) throw new Error('элемент карточки не отрисован');
    return box.y;
  };
  const headerY = await y(header);
  const statsY = await y(page.getByTestId('card-stats'));
  const spheresY = await y(page.getByTestId('spheres-contractor'));
  const reliabilityY = await y(page.getByTestId('card-reliability'));
  const dealsY = await y(page.getByTestId('card-deals'));
  const legendY = await y(page.getByTestId('card-legend'));

  expect(headerY, 'шапка с именем — выше плиток фактов').toBeLessThan(statsY);
  expect(statsY, 'плитки фактов — между шапкой и «по сферам и ролям»').toBeLessThan(spheresY);
  expect(spheresY, '«по сферам и ролям» — выше «надёжности»').toBeLessThan(reliabilityY);
  expect(reliabilityY, '«надёжность» — выше списка сделок').toBeLessThan(dealsY);
  expect(dealsY, 'пояснение — последним блоком').toBeLessThan(legendY);
});

test('снимки карточки репутации: 360 и 1280', async ({ page }) => {
  const dir = new URL('../../../screenshots/', import.meta.url).pathname;
  await page.setViewportSize({ width: 360, height: 900 });
  await page.goto('/@akovalev');
  await expect(page.getByTestId('spheres-contractor')).toBeVisible();
  await page.screenshot({ path: `${dir}reputation-card-360.png`, fullPage: true });

  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(page.getByTestId('spheres-contractor')).toBeVisible();
  await page.screenshot({ path: `${dir}reputation-card-1280.png`, fullPage: true });
});
