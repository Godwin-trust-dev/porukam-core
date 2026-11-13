/**
 * Кадры для витрин сторов (Google Play / RuStore / App Store) — телефон, EN и RU.
 *
 * НЕ входит в обычный прогон e2e: гоняется только с `STORE_SHOTS=1`, потому что
 * пишет файлы в `docs/ops/store-listing/screenshots/**` и живёт по расписанию
 * витрины, а не по расписанию регрессии.
 *
 *   flock /tmp/porukam-e2e.lock env PW_PORT=4207 STORE_SHOTS=1 \
 *     npx playwright test --workers=1 tests/e2e/store-screenshots.spec.ts
 *
 * Язык — `STORE_LANG=en` (по умолчанию, Google Play) или `STORE_LANG=ru` (RuStore):
 * интерфейс, данные моков и подписи оформленных кадров — на выбранном языке,
 * файлы — в `screenshots/<lang>` и `screenshots/<lang>-framed`.
 *
 * Размер кадра — требование Google Play: сторона 320–3840 px и длинная сторона
 * не больше двойной короткой. 390×844 (типичный телефон) в это НЕ укладывается,
 * поэтому снимаем 390×780 при `deviceScaleFactor: 3` — ровно 1170×2340 (2:1).
 * RuStore (RU-кадры) ждёт портрет 9:16: телефон 405×720 × 8/3 = 1080×1920
 * (ширина 360 делала экраны тесными — пропадала кнопка «Принять этап»),
 * оформленный кадр — тоже 1080×1920 (владелец 16.09: 2:1 в карточке RuStore
 * смотрится плохо).
 * Оформленные кадры — 1080×2160 (тоже 2:1).
 *
 * Английские ДАННЫЕ (не только интерфейс) — демо-набор моков `web/src/mocks/
 * demoEn.ts`, включается `localStorage['porukam.mockData'] = 'en'`. Русские
 * фикстуры остаются дефолтом, остальные e2e не затрагиваются — для RU-кадров
 * флаг `'ru'` оставляет русские сиды, но в витринном виде (см. `demoEn.ts`).
 */
import { expect, test, type Page } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readPngInfo, toRgbPng } from './storePng';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const LANG: 'en' | 'ru' = process.env.STORE_LANG === 'ru' ? 'ru' : 'en';
const RAW_DIR = join(ROOT, `docs/ops/store-listing/screenshots/${LANG}`);
const FRAMED_DIR = join(ROOT, `docs/ops/store-listing/screenshots/${LANG}-framed`);

/** Геометрия кадров: EN — 2:1 под Google Play, RU — 9:16 под RuStore. */
const LAYOUT = {
  en: {
    viewport: { width: 390, height: 780 },
    scale: 3,
    raw: { width: 1170, height: 2340 },
    framed: { width: 1080, height: 2160 },
    frame: { padTop: 104, ruleGap: 40, phoneGap: 62, phoneWidth: 860, center: false },
  },
  ru: {
    viewport: { width: 405, height: 720 },
    scale: 8 / 3,
    raw: { width: 1080, height: 1920 },
    framed: { width: 1080, height: 1920 },
    // Подпись + телефон центрируются по высоте: у однострочной подписи иначе
    // под телефоном остаётся пустая полоса.
    frame: { padTop: 0, ruleGap: 32, phoneGap: 48, phoneWidth: 850, center: true },
  },
}[LANG];

/** Кадр телефона: viewport × 3. */
const RAW = LAYOUT.raw;
/** Оформленный кадр витрины. */
const FRAMED = LAYOUT.framed;

/** Подписи витрины — 2–5 слов, по одной на кадр. */
const CAPTIONS = {
  en: [
    'Contracts that finish',
    'Every deal in one place',
    'One card, whole deal',
    'Checklist acceptance',
    'Sign in a minute',
    'Chat that becomes a contract',
    'Reputation from facts',
    'Start a deal in minutes',
  ],
  ru: [
    'Договоры, доведённые до конца',
    'Все сделки в одном месте',
    'Вся сделка в одной карточке',
    'Приёмка по чек-листу',
    'Подпись за минуту',
    'Из переписки — в договор',
    'Репутация на фактах',
    'Договор за несколько минут',
  ],
} as const;

const FILES = [
  '01-home.png',
  '02-deals.png',
  '03-contract.png',
  '04-stages.png',
  '05-sign.png',
  '06-chat.png',
  '07-reputation.png',
  '08-new-contract.png',
] as const;

const SHOTS = FILES.map((file, i) => ({ file, caption: CAPTIONS[LANG][i]! }));

/** Подписи формы входа — на языке интерфейса кадров. */
const LOGIN = {
  en: { phone: 'Phone number', getCode: 'Get code', code: 'Confirmation code', signIn: 'Sign in' },
  ru: { phone: 'Номер телефона', getCode: 'Получить код', code: 'Код подтверждения', signIn: 'Войти' },
}[LANG];

/**
 * Ключи, гасящие всё, что не должно попасть в витрину: предложение установить
 * PWA (в headless-Chromium оно всплывает после первой же навигации — ветка
 * `needsManualHowTo`), cookie-баннер и промо пуш-уведомлений.
 */
function primeStorage(lang: string): void {
  try {
    localStorage.setItem('porukam.mockData', lang);
    localStorage.setItem('porukam.appInstalled', '1');
    localStorage.setItem('porukam.installBannerDismissedAt', String(Date.now()));
    localStorage.setItem('porukam.cookieBannerShown', '1');
    localStorage.setItem('porukam.cookieChoice', 'necessary');
    localStorage.setItem('porukam.pushPromoDismissed', '1');
  } catch {
    /* приватный режим — кадры просто снимутся с баннерами */
  }
}

/** Вход по телефону: только он даёт `pf-person-1` — профиль со всеми мок-сделками
 * (Google-мок заводит свежий GLOBAL-аккаунт, у которого сделок нет). */
async function login(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByLabel(LOGIN.phone).fill('+7 900 123-45-67');
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: LOGIN.getCode }).click();
  await page.getByLabel(LOGIN.code).fill('111111');
  await page.getByRole('button', { name: LOGIN.signIn, exact: true }).click();
  await page.waitForURL(/\/$/, { timeout: 15_000 });
}

/** Переход БЕЗ перезагрузки: сессия живёт в памяти вкладки (`authStore`,
 * §13.2), `page.goto()` её потеряет. */
async function go(page: Page, path: string): Promise<void> {
  await page.evaluate((to) => {
    window.history.pushState({}, '', to);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, path);
}

/**
 * В песочнице нет emoji-шрифта, и «🔒» из подписей («🔒 Frozen», «🔒 hash
 * recorded») рисуется квадратом-тофу. На телефоне пользователя символ рисуется
 * нормально; для кадра убираем ровно его, смысл подписи не меняется.
 */
async function dropUnrenderableEmoji(page: Page): Promise<void> {
  await page.evaluate(() => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const emoji = /[\u{1F300}-\u{1FAFF}]️?\s?/gu;
    let node: Node | null;
    while ((node = walker.nextNode())) {
      if (node.nodeValue && emoji.test(node.nodeValue)) {
        node.nodeValue = node.nodeValue.replace(emoji, '');
      }
    }
  });
}

/** Один кадр: дождаться шрифтов, убрать нерисуемые символы, сохранить как RGB. */
async function shoot(page: Page, file: string): Promise<void> {
  await page.evaluate(() => document.fonts.ready);
  await dropUnrenderableEmoji(page);
  await page.waitForTimeout(250);
  const png = toRgbPng(await page.screenshot());
  const info = readPngInfo(png);
  expect({ width: info.width, height: info.height }, `размер кадра ${file}`).toEqual(RAW);
  expect(info.colorType, `${file} — 24-битный PNG без альфы`).toBe(2);
  writeFileSync(join(RAW_DIR, file), png);
}

/** Фирменные шрифты завендорены в репозитории (ТЗ §5.2, без Google Fonts) —
 * в витринную страницу они вшиваются data-URI: у неё нет своего origin. */
function fontDataUri(file: string): string {
  const bytes = readFileSync(join(ROOT, 'web/public/fonts', file)).toString('base64');
  return `data:font/woff2;base64,${bytes}`;
}

/** Оформленный кадр: подпись + телефон на фирменном чернильном градиенте.
 * Страница собирается на `about:blank` и НЕ ходит на preview-сервер: его
 * `index.html` тянет стили приложения, и кремовый фон приложения перебивал бы
 * фон витрины (`setContent` сохраняет `<link>` исходного документа). */
function framePage(caption: string, imageDataUri: string): string {
  return `
<style>
  @font-face { font-family: 'Onest'; font-weight: 400 800; font-display: block;
    src: url('${fontDataUri('onest-latin.woff2')}') format('woff2');
    unicode-range: U+0000-00FF, U+0131, U+0152-0153, U+2000-206F, U+20AC, U+2122; }
  @font-face { font-family: 'Onest'; font-weight: 400 800; font-display: block;
    src: url('${fontDataUri('onest-cyrillic.woff2')}') format('woff2');
    unicode-range: U+0301, U+0400-045F, U+0490-0491, U+04B0-04B1, U+2116; }
  @font-face { font-family: 'Inter'; font-weight: 400 700; font-display: block;
    src: url('${fontDataUri('inter-latin.woff2')}') format('woff2'); }
  html, body { margin: 0; padding: 0; }
  body {
    width: ${FRAMED.width}px; height: ${FRAMED.height}px; overflow: hidden;
    background: linear-gradient(160deg, #2A4763 0%, #16283C 60%, #101F30 100%);
    display: flex; flex-direction: column; align-items: center;
    padding: ${LAYOUT.frame.padTop}px 90px 0; box-sizing: border-box;
    justify-content: ${LAYOUT.frame.center ? 'center' : 'flex-start'};
  }
  .caption {
    font-family: 'Onest', system-ui, sans-serif; font-weight: 700; font-size: 66px;
    line-height: 1.12; letter-spacing: -0.02em; color: #FFFFFF; text-align: center;
    text-wrap: balance;
    margin: 0; max-width: 860px;
  }
  .rule { width: 132px; height: 8px; border-radius: 100px; margin: ${LAYOUT.frame.ruleGap}px 0 0;
    background: linear-gradient(135deg, #FFB347 0%, #FF9E2C 45%, #FFC85A 100%); }
  .phone {
    width: ${LAYOUT.frame.phoneWidth}px; margin-top: ${LAYOUT.frame.phoneGap}px; border-radius: 46px; overflow: hidden;
    box-shadow: 0 46px 96px rgba(0, 0, 0, 0.5), 0 0 0 2px rgba(199, 210, 222, 0.18);
  }
  .phone img { display: block; width: 100%; }
</style>
<h1 class="caption">${caption}</h1>
<div class="rule"></div>
<div class="phone"><img src="${imageDataUri}" alt=""></div>
`;
}

test.describe(`витрина сторов · кадры телефона (${LANG.toUpperCase()})`, () => {
  test.skip(process.env.STORE_SHOTS !== '1', 'Кадры витрины снимаются отдельно: STORE_SHOTS=1');

  test.use({
    viewport: LAYOUT.viewport,
    deviceScaleFactor: LAYOUT.scale,
    isMobile: true,
    hasTouch: true,
    // Язык посетителя — и для интерфейса, и для Intl-форматов (деньги, даты).
    locale: LANG === 'ru' ? 'ru-RU' : 'en-US',
  });

  test('восемь кадров + оформленная версия', async ({ page, browser }) => {
    test.setTimeout(180_000);
    mkdirSync(RAW_DIR, { recursive: true });
    mkdirSync(FRAMED_DIR, { recursive: true });

    await page.addInitScript(primeStorage, LANG);
    await login(page);

    // 1. Рабочий стол: «требует вашего действия» + активные сделки.
    await page.getByTestId('dashboard-attention').waitFor();
    await page.getByTestId('dashboard-contracts').waitFor();
    await shoot(page, '01-home.png');

    // 2. Список сделок: разные статусы и контрагенты.
    await go(page, '/contracts');
    await page.getByTestId('contracts-list').waitFor();
    await shoot(page, '02-deals.png');

    // 3. Карточка договора на согласовании: стороны, сумма, цветные действия.
    await go(page, '/contracts/rc-review-1');
    await page.getByTestId('card-parties').waitFor();
    await page.getByTestId('passport-sum').waitFor();
    await shoot(page, '03-contract.png');

    // 4. Приёмка этапа по чек-листу: один пункт отмечен, к нему приложено фото.
    await go(page, '/contracts/rc-signed-review-1/stages/ms-review-1');
    await page.getByTestId('acceptance-review-list').waitFor();
    await page.getByTestId('acceptance-review-item').first().click();
    // Кадр — от приложенного фото до кнопки «Принять этап»: подводим карточку
    // доказательства под шапку, остальное укладывается в экран само.
    await page.evaluate(() => {
      const evidence = document.querySelector('[data-testid="evidence-item"]');
      const top = evidence ? evidence.getBoundingClientRect().top + window.scrollY : 0;
      window.scrollTo(0, Math.max(0, top - 96));
    });
    await shoot(page, '04-stages.png');

    // 5. Подписание: замороженная версия, хеш целостности и метка времени.
    await go(page, '/contracts/rc-awaiting-other-signed-1/sign');
    await page.getByTestId('frozen-version-hash').waitFor();
    await shoot(page, '05-sign.png');

    // 6. Переписка по сделке: реплики обеих сторон плюс события договора.
    await go(page, '/chat/rc-progress-1');
    await page.getByTestId('chat-messages').waitFor();
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await shoot(page, '06-chat.png');

    // 7. Карточка репутации: цифры по фактам сделок, а не оценки.
    await go(page, '/@akovalev');
    await page.getByTestId('card-stats').waitFor();
    await shoot(page, '07-reputation.png');

    // 8. Мастер: выбор типа сделки — первый шаг создания договора.
    await go(page, '/contracts/new');
    await page.getByTestId('type-service').click();
    await shoot(page, '08-new-contract.png');

    // ── оформленные кадры ──────────────────────────────────────────────
    // Отдельный контекст: у витринной страницы свой размер (1080×2160) и
    // масштаб 1 — кадр телефона в неё вставляется картинкой.
    const shell = await browser.newContext({ viewport: FRAMED, deviceScaleFactor: 1 });
    const framer = await shell.newPage();
    for (const { file, caption } of SHOTS) {
      const raw = readFileSync(join(RAW_DIR, file)).toString('base64');
      await framer.setContent(framePage(caption, `data:image/png;base64,${raw}`));
      await framer.evaluate(() => document.fonts.ready);
      await framer.waitForTimeout(200);
      const png = toRgbPng(await framer.screenshot());
      const info = readPngInfo(png);
      expect({ width: info.width, height: info.height }, `размер оформленного ${file}`).toEqual(FRAMED);
      expect(info.colorType, `${file} — 24-битный PNG без альфы`).toBe(2);
      writeFileSync(join(FRAMED_DIR, file), png);
    }
    await shell.close();
  });
});
