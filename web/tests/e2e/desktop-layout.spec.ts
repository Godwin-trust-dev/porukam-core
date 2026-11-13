import { test, expect, type Page } from '@playwright/test';

/**
 * DEV-19 · Десктоп-адаптив — приёмка §8: прогон на 360 · 768 · 1024 · 1440.
 * `<1024` — мобильная стопка, `≥1024` — master-detail / мультиколонка /
 * паспорт-рейл. Один экран с брейкпоинтом, не второй набор экранов (ADR-099).
 */

const PHONE = { width: 360, height: 780 };
const TABLET = { width: 768, height: 1024 };
/** Последняя «мобильная» ширина — граница обязана проходить ровно здесь. */
const MOBILE_MAX = { width: 1023, height: 900 };
const DESKTOP = { width: 1024, height: 900 };
const WIDE = { width: 1440, height: 900 };

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

async function openPath(page: Page, path: string): Promise<void> {
  await page.evaluate((p) => {
    window.history.pushState({}, '', p);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, path);
}

/** Горизонтального скролла на рабочих экранах быть не должно (§8). */
async function expectNoHorizontalScroll(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => {
    const d = document.documentElement;
    return d.scrollWidth - d.clientWidth;
  });
  expect(overflow).toBeLessThanOrEqual(1); // 1px — запас на субпиксельное округление
}

test.describe('§2 «Мои договоры» — master-detail', () => {
  test('⭐ ≥1024: клик по строке выделяет её и открывает детали, не уходя со списка', async ({ page }) => {
    await page.setViewportSize(WIDE);
    await login(page);
    await openPath(page, '/contracts');

    const row = page.getByTestId('contract-list-row').first();
    await expect(row).toBeVisible();
    await row.click();

    // Выбор — в URL, а не во внутреннем состоянии.
    await expect(page).toHaveURL(/\/contracts\?.*sel=/);
    // Список НА МЕСТЕ, страница карточки не открывалась.
    await expect(page.getByTestId('contracts-list')).toBeVisible();
    await expect(page.getByTestId('contract-detail-pane')).toBeVisible();
    await expect(row).toHaveAttribute('aria-current', 'true');
    await expectNoHorizontalScroll(page);
  });

  test('⭐ F5 не теряет выбор, «назад» его отменяет', async ({ page }) => {
    await page.setViewportSize(WIDE);
    await login(page);
    await openPath(page, '/contracts');
    await page.getByTestId('contract-list-row').first().click();
    await expect(page.getByTestId('contract-detail-pane')).toBeVisible();

    const selected = new URL(page.url()).searchParams.get('sel');
    expect(selected).toBeTruthy();

    // «Назад» отменяет выбор — это обычная запись в истории, а не свой стек.
    await page.goBack();
    await expect(page).not.toHaveURL(/sel=/);
    await expect(page.getByTestId('contracts-list')).toBeVisible();

    // F5 выбор не теряет: он в адресе, а не в состоянии компонента.
    //
    // Что после перезагрузки по этому адресу СНОВА открывается та же карточка,
    // проверяет соседний тест про deep-link `?sel=` — здесь настоящий
    // `page.reload()` до карточки не доходит по причине, к DEV-19 отношения не
    // имеющей: токены сессии живут только в памяти (ТЗ §13.2, `authStore` —
    // refresh уедет в защищённое хранилище в Ф4/Ф6), поэтому любой F5 в этой
    // сборке уводит на `/login`. Адрес при этом сохраняется — это и проверяем.
    await page.goForward();
    await expect(page).toHaveURL(new RegExp(`sel=${selected!}`));
    await page.reload();
    await expect(page).toHaveURL(new RegExp(`sel=${selected!}`));
  });

  test('⭐ deep-link ?sel= открывает карточку выбранного договора сразу', async ({ page }) => {
    await page.setViewportSize(WIDE);
    await login(page);
    await openPath(page, '/contracts?sel=rc-review-1');

    const pane = page.getByTestId('contract-detail-pane');
    await expect(pane).toBeVisible();
    await expect(pane).toHaveAttribute('data-contract-id', 'rc-review-1');
  });

  test('⭐ <1024: колонки деталей нет, тап по строке — переход на карточку', async ({ page }) => {
    await page.setViewportSize(MOBILE_MAX);
    await login(page);
    await openPath(page, '/contracts');

    await expect(page.getByTestId('master-detail-pane')).toHaveCount(0);
    await page.getByTestId('contract-list-row').first().click();
    await expect(page).toHaveURL(/\/contracts\/[^/?]+$/, { timeout: 10_000 });
  });

  test('«Полная карточка» из деталей уводит на §4', async ({ page }) => {
    await page.setViewportSize(WIDE);
    await login(page);
    await openPath(page, '/contracts?sel=rc-review-1');

    await page.getByTestId('pane-full-card').click();
    await expect(page).toHaveURL(/\/contracts\/rc-review-1$/);
  });
});

test.describe('§3 Дашборд — мультиколонка + правый рейл', () => {
  test('⭐ ≥1024: рейл стоит СПРАВА от главного столбца', async ({ page }) => {
    await page.setViewportSize(WIDE);
    await login(page);

    const rail = page.getByTestId('dashboard-rail');
    const grid = page.getByTestId('dashboard-contracts');
    await expect(rail).toBeVisible();
    await expect(grid).toBeVisible();

    const railBox = (await rail.boundingBox())!;
    const gridBox = (await grid.boundingBox())!;
    // Рейл начинается там, где кончился главный столбец — это и есть «в две колонки».
    expect(railBox.x).toBeGreaterThanOrEqual(gridBox.x + gridBox.width - 1);
    await expectNoHorizontalScroll(page);
  });

  test('⭐ <1024: рейл уходит ВНИЗ, в один столбец', async ({ page }) => {
    await page.setViewportSize(PHONE);
    await login(page);

    const rail = page.getByTestId('dashboard-rail');
    const grid = page.getByTestId('dashboard-contracts');
    await expect(rail).toBeVisible();

    const railBox = (await rail.boundingBox())!;
    const gridBox = (await grid.boundingBox())!;
    expect(railBox.y).toBeGreaterThan(gridBox.y);
    await expectNoHorizontalScroll(page);
  });

  // DEV-20 §5 отменяет грид плиток (DEV-19 §3): на широком экране дашборд
  // показывает те же плотные строки, что список сделок. Проверяем плотность:
  // строки стоят стопкой и каждая укладывается в компакт-высоту (≤ 72px при
  // визуальных 54–64), то есть «коробок» на элемент больше нет.
  test('сделки — плотные строки на одной поверхности, а не плитки', async ({ page }) => {
    await page.setViewportSize(WIDE);
    await login(page);

    const list = page.getByTestId('dashboard-contracts');
    await expect(list).toBeVisible();
    await expect(page.getByTestId('contract-tile')).toHaveCount(0);

    const rows = list.getByTestId('contract-list-row');
    await expect(rows.first()).toBeVisible();
    const count = await rows.count();
    test.skip(count < 2, 'нужны минимум две сделки, чтобы проверить стопку');

    const first = (await rows.nth(0).boundingBox())!;
    const second = (await rows.nth(1).boundingBox())!;
    expect(second.y).toBeGreaterThanOrEqual(first.y + first.height - 1); // стопка, не ряд
    expect(first.height).toBeLessThanOrEqual(72);
  });
});

test.describe('§4 Карточка договора — паспорт-рейл + широкое тело', () => {
  test('⭐ ≥1024: паспорт СЛЕВА от тела и остаётся видимым при скролле', async ({ page }) => {
    await page.setViewportSize(WIDE);
    await login(page);
    await openPath(page, '/contracts/rc-review-1');

    const passport = page.getByTestId('contract-passport');
    await expect(passport).toBeVisible();

    const layout = page.getByTestId('passport-layout');
    const passportBox = (await passport.boundingBox())!;
    const layoutBox = (await layout.boundingBox())!;
    expect(passportBox.width).toBeLessThan(layoutBox.width / 2); // рейл, а не половина экрана

    // Липкий: после прокрутки паспорт всё ещё в окне.
    await page.mouse.wheel(0, 600);
    await expect(passport).toBeInViewport();
    await expectNoHorizontalScroll(page);
  });

  test('⭐ <1024: паспорт становится верхней шапкой (над телом)', async ({ page }) => {
    await page.setViewportSize(TABLET);
    await login(page);
    await openPath(page, '/contracts/rc-review-1');

    const passport = page.getByTestId('contract-passport');
    await expect(passport).toBeVisible();
    // Доска B / ADR-152: на узком экране «‹ название · статус» уезжает в
    // шапку оболочки, вкладки карточки — под ней, стороны и сумма — в обзоре.
    const head = page.getByTestId('shell-header-title');
    await expect(head).toBeVisible();
    const tabs = passport.getByRole('tablist').first();

    const headBox = (await head.boundingBox())!;
    const tabsBox = (await tabs.boundingBox())!;
    expect(headBox.y).toBeLessThan(tabsBox.y);
    await expectNoHorizontalScroll(page);
  });
});

test.describe('§5 Формы — центрированы, не растянуты', () => {
  test('⭐ мастер создания: контейнер ≤860px и стоит по центру рабочей области', async ({ page }) => {
    await page.setViewportSize(WIDE);
    await login(page);
    await openPath(page, '/contracts/new/type');

    await expect(page.getByTestId('type-service')).toBeVisible();

    const { paneWidth, leftGap, rightGap } = await page.evaluate(() => {
      const mainBox = document.querySelector('main')!.getBoundingClientRect();
      const pane = document.querySelector('[data-testid="wizard-pane"]')!.getBoundingClientRect();
      return {
        paneWidth: pane.width,
        leftGap: pane.left - mainBox.left,
        rightGap: mainBox.right - pane.right,
      };
    });

    expect(paneWidth).toBeLessThanOrEqual(860);
    // По центру: поля слева и справа отличаются не больше, чем на пиксель округления.
    expect(Math.abs(leftGap - rightGap)).toBeLessThanOrEqual(2);
    await expectNoHorizontalScroll(page);
  });
});

test.describe('§1 Оболочка — брейкпоинт один на продукт', () => {
  test('⭐ граница ровно между 1023 и 1024: сайдбар ↔ нижняя навигация', async ({ page }) => {
    await login(page);

    await page.setViewportSize(MOBILE_MAX);
    await expect(page.getByTestId('brand-home')).toBeHidden();

    await page.setViewportSize(DESKTOP);
    await expect(page.getByTestId('brand-home')).toBeVisible();
  });

  test('нет горизонтального скролла на всех приёмочных ширинах', async ({ page }) => {
    await login(page);
    for (const size of [PHONE, TABLET, DESKTOP, WIDE]) {
      await page.setViewportSize(size);
      for (const path of ['/', '/contracts', '/notifications']) {
        await openPath(page, path);
        await page.waitForTimeout(150);
        await expectNoHorizontalScroll(page);
      }
    }
  });
});
