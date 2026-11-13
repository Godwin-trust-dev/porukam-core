import { test, expect, type Page } from '@playwright/test';

/**
 * DEV-20_2 §12 — приёмка компакт-плотности, машинная часть.
 *
 * Две вещи, которые ломаются молча и которые глазами ловят через раз:
 * содержимое, вылезающее за ширину экрана (полоса контента его ОБРЕЗАЕТ —
 * `overflow-x: clip`, — и кнопка просто становится недоступной), и полоса
 * вкладок, уехавшая в боковой скролл.
 */

async function login(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Номер телефона').fill('+7 900 123-45-67');
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Получить код' }).click();
  await page.getByLabel('Код подтверждения').fill('111111');
  await page.getByRole('button', { name: 'Войти' }).click();
  await expect(page).toHaveURL(/\/$/, { timeout: 15_000 });
}

async function openPath(page: Page, path: string): Promise<void> {
  await page.evaluate((p) => {
    window.history.pushState({}, '', p);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, path);
  await page.waitForTimeout(800);
}

const PATHS = ['/', '/contracts', '/notifications', '/me', '/me/settings', '/chat', '/payments'];
const WIDTHS = [360, 768, 1440];

for (const width of WIDTHS) {
  test(`§12: на ${width}px ничего не вылезает за ширину экрана`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await login(page);

    for (const path of PATHS) {
      await openPath(page, path);
      // Сам документ вбок не прокручивается…
      const pageOverflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(pageOverflow, `${path} — горизонтальный скролл страницы`).toBeLessThanOrEqual(0);

      // …и ни один блок не уехал за правый край под обрезку полосы контента:
      // `overflow-x: clip` прячет такое от scrollWidth, но кнопка под ним
      // всё равно недоступна (так /me терял «Портфолио» и «Поделиться»).
      //
      // Намеренную обрезку не считаем дефектом: если МЕЖДУ элементом и
      // полосой контента есть свой `overflow: hidden|clip` — это усечение
      // многоточием (название строки списка), а не сбежавшая раскладка.
      const clipped = await page.evaluate((vw) => {
        const bad: string[] = [];
        const main = document.querySelector('main');
        document.querySelectorAll<HTMLElement>('main *').forEach((el) => {
          const r = el.getBoundingClientRect();
          if (r.width <= 24 || r.right <= vw + 1) return;
          if (getComputedStyle(el).position === 'fixed') return; // FAB и оверлеи
          for (let p = el.parentElement; p && p !== main; p = p.parentElement) {
            const o = getComputedStyle(p);
            if (/hidden|clip|auto|scroll/.test(o.overflowX)) return;
          }
          bad.push(`${el.tagName}.${String(el.className).slice(0, 40)}`);
        });
        return bad.slice(0, 5);
      }, width);
      expect(clipped, `${path} — блоки за правым краем`).toEqual([]);
    }
  });
}

test('§12: полоса вкладок нигде не скроллится вбок', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 900 });
  await login(page);

  for (const path of ['/contracts', '/notifications', '/disputes', '/me/settings']) {
    await openPath(page, path);
    const tablists = page.getByRole('tablist');
    const count = await tablists.count();
    for (let i = 0; i < count; i += 1) {
      const overflow = await tablists.nth(i).evaluate((el) => el.scrollWidth - el.clientWidth);
      expect(overflow, `${path} — вкладки прокручиваются вбок`).toBeLessThanOrEqual(0);
    }
  }
});

/**
 * Решение владельца 05.09: в строке платежа статус СЛОВОМ дублировал подпись
 * группы. Дубль был не бесплатным: `ListRow .status` стоит `flex: none`, а
 * `.meta` — `flex: 1`, то есть слово забирало ширину у второй строки жёстко, а
 * усекалась всегда она («договор · контрагент»).
 *
 * Меряем не «влезло ли имя» (это зависит от длины названия договора, которая
 * ничем не ограничена, — такой тест краснел бы от новой строки в моках), а
 * ровно то, за что отвечает правка: СПРАВА ОТ второй строки в строке платежа
 * не стоит ничего. Вернётся `StatusWord` — метка отъест ширину, правый край
 * `.meta` перестанет совпадать с краем строки, и тест покраснеет.
 *
 * Для сравнения на том же экране: на «Сделках», где слово-статус остаётся
 * (там строки одного списка несут РАЗНЫЕ состояния и различает их только оно),
 * та же вторая строка получает 173–209px против 288px здесь.
 */
test('§12 (05.09): /payments на 360px — вторую строку не обрезает статус-дубль', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 900 });
  await login(page);
  await openPath(page, '/payments');
  await page.getByTestId('payments-groups').waitFor();

  const rows = await page.evaluate(() => {
    const out: { meta: number; avail: number; text: string }[] = [];
    document
      .querySelectorAll<HTMLElement>('[data-testid="payments-groups"] [data-testid="counterparty-link"]')
      .forEach((link) => {
        // Ближайший предок, который режет многоточием, — это и есть вторая
        // строка (`ListRow .meta`); её сосед-контейнер задаёт доступную ширину.
        let meta: HTMLElement | null = link.parentElement;
        while (meta && getComputedStyle(meta).textOverflow !== 'ellipsis') meta = meta.parentElement;
        if (!meta || !meta.parentElement) return;
        const holder = meta.parentElement;
        const pad = parseFloat(getComputedStyle(holder).paddingRight) || 0;
        out.push({
          meta: Math.round(meta.getBoundingClientRect().right),
          avail: Math.round(holder.getBoundingClientRect().right - pad),
          text: (meta.textContent ?? '').trim().slice(0, 40),
        });
      });
    return out;
  });

  expect(rows.length, 'на /payments не нашлось ни одной строки с контрагентом').toBeGreaterThan(0);
  for (const row of rows) {
    expect(row.avail - row.meta, `«${row.text}»: справа от второй строки что-то стоит`).toBeLessThanOrEqual(1);
  }
});
