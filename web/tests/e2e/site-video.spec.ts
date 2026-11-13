/**
 * Ролик «как это работает» для публичного контура (ADR-195, решение владельца 29.10:
 * *«только английский, остальное субтитры»*).
 *
 * НЕ входит в обычный прогон e2e — как и кадры витрины, гоняется отдельно:
 *
 *   cd web && flock /tmp/porukam-e2e.lock env PW_PORT=4209 SITE_VIDEO=1 \
 *     npx playwright test --workers=1 tests/e2e/site-video.spec.ts
 *
 * Почему роликом управляет тест, а не человек с экранной записью: интерфейс
 * меняется каждую неделю, и записанный руками ролик начинает врать на первой же
 * правке — молча, потому что никто не пересматривает его после каждого релиза.
 * Этот пересниматeтся одной командой и падает, если экран, который он
 * показывает, исчез или переименован.
 *
 * Язык в кадре — ТОЛЬКО английский. Интерфейс в видео физически одноязычен, и
 * субтитрами это не лечится наполовину: остальные 28 языков получают субтитры
 * (`scripts/l10n/build-video-captions.mjs`), собранные из уже утверждённых
 * текстов витрины Google Play — того же неймспейса `site`, из которого собран
 * лендинг. Поэтому подписи к ролику не могут разойтись ни с магазином, ни со
 * страницей, на которой он стоит.
 *
 * Хронометраж задан ЗДЕСЬ и выгружается в `chapters.json`: субтитры собираются
 * из этого файла, а не подгоняются на глаз. Главы по смыслу — ровно пять блоков
 * лендинга (`site.contract*`, `site.stages*`, `site.payment*`, `site.evidence*`,
 * `site.reputation*`), поэтому ролик рассказывает ту же историю, что текст
 * вокруг него, только в движении.
 */
import { expect, test, type Browser, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const MEDIA_DIR = join(ROOT, 'web/public/media');
const RAW_DIR = join(ROOT, 'web/test-results/site-video');

/** Кадр 16:9: ролик стоит в правой колонке героя, а не на весь экран. */
const SIZE = { width: 1280, height: 720 };

/**
 * Пять глав по 9 секунд. Девять — не «красивое число»: столько нужно, чтобы
 * прочитать субтитр из двух предложений (текст блока витрины — 2–3 фразы) и
 * успеть посмотреть на экран. Короче — субтитр не дочитывается, длиннее —
 * ролик перестаёт быть коротким, а владелец просил короткий.
 */
const CHAPTER_SECONDS = 9;

type ChapterKey = 'contract' | 'stages' | 'payment' | 'evidence' | 'reputation';

/** Что попадёт в `chapters.json` — вход для сборщика субтитров. */
type Chapter = { key: ChapterKey; startMs: number; endMs: number };

/**
 * Гасим всё, что не должно попасть в ролик: предложение установить PWA,
 * cookie-баннер, промо пуш-уведомлений. Данные — английский демо-набор
 * (`web/src/mocks/demoEn.ts`), тот же, что в кадрах Google Play.
 */
function primeStorage(): void {
  try {
    localStorage.setItem('porukam.mockData', 'en');
    localStorage.setItem('porukam.appInstalled', '1');
    localStorage.setItem('porukam.installBannerDismissedAt', String(Date.now()));
    localStorage.setItem('porukam.cookieBannerShown', '1');
    localStorage.setItem('porukam.cookieChoice', 'necessary');
    localStorage.setItem('porukam.pushPromoDismissed', '1');
  } catch {
    /* приватный режим — ролик снимется с баннерами, это увидит проверка ниже */
  }
}

/** Вход по телефону: только он даёт профиль со всеми мок-сделками. */
async function login(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Phone number').fill('+7 900 123-45-67');
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Get code' }).click();
  await page.getByLabel('Confirmation code').fill('111111');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.waitForURL(/\/$/, { timeout: 15_000 });
}

/** Переход БЕЗ перезагрузки: сессия живёт в памяти вкладки (§13.2). */
async function go(page: Page, path: string): Promise<void> {
  await page.evaluate((to) => {
    window.history.pushState({}, '', to);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, path);
}

/**
 * В песочнице нет emoji-шрифта, и «🔒» из подписей («🔒 Frozen», «🔒 hash
 * recorded») рисуется квадратом-тофу — тот же приём, что в кадрах витрины
 * (`store-screenshots.spec.ts`). У пользователя символ рисуется нормально;
 * из ролика убираем ровно его, смысл подписи не меняется.
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

/** Playwright кладёт свой ffmpeg рядом с браузерами — системный не нужен. */
function ffmpegPath(): string {
  const home = process.env.HOME ?? '';
  return join(home, '.cache/ms-playwright/ffmpeg-1010/ffmpeg-linux');
}

test.describe('публичный контур · ролик «как это работает» (EN)', () => {
  test.skip(process.env.SITE_VIDEO !== '1', 'Ролик снимается отдельно: SITE_VIDEO=1');

  test('пять глав, английский интерфейс, хронометраж в chapters.json', async ({
    browser,
  }: {
    browser: Browser;
  }) => {
    test.setTimeout(300_000);
    mkdirSync(MEDIA_DIR, { recursive: true });
    rmSync(RAW_DIR, { recursive: true, force: true });
    mkdirSync(RAW_DIR, { recursive: true });

    const context = await browser.newContext({
      viewport: SIZE,
      deviceScaleFactor: 1,
      locale: 'en-US',
      recordVideo: { dir: RAW_DIR, size: SIZE },
    });
    await context.addInitScript(primeStorage);
    const page = await context.newPage();

    // Вход попадает в запись и потом срезается: начать запись уже внутри
    // приложения нельзя — сессия живёт в памяти вкладки, а новый контекст
    // (и новая запись) её теряет. Поэтому запоминаем, сколько секунд вначале
    // лишние, и отрезаем их ffmpeg'ом.
    const recordingStart = Date.now();
    await login(page);
    await page.getByTestId('dashboard-contracts').waitFor();
    await page.evaluate(() => document.fonts.ready);
    const leadInMs = Date.now() - recordingStart;

    const chapters: Chapter[] = [];
    /** Глава фиксированной длины: сначала показываем экран, потом доливаем паузу. */
    const chapter = async (key: ChapterKey, body: () => Promise<void>): Promise<void> => {
      const startMs = Date.now() - recordingStart;
      await body();
      await dropUnrenderableEmoji(page);
      const spent = Date.now() - recordingStart - startMs;
      await page.waitForTimeout(Math.max(800, CHAPTER_SECONDS * 1000 - spent));
      chapters.push({ key, startMs, endMs: Date.now() - recordingStart });
    };

    // 1. Договор за несколько минут: мастер, выбор типа сделки.
    await chapter('contract', async () => {
      await go(page, '/contracts/new');
      await page.getByTestId('type-service').waitFor();
      await page.waitForTimeout(1500);
      await page.getByTestId('type-service').click();
      await page.waitForTimeout(1200);
    });

    // 2. Этапы и приёмка по чек-листу: лист с пунктами и приложенным фото.
    await chapter('stages', async () => {
      await go(page, '/contracts/rc-signed-review-1/stages/ms-review-1');
      await page.getByTestId('acceptance-review-list').waitFor();
      await page.waitForTimeout(1200);
      await page.getByTestId('acceptance-review-item').first().click();
    });

    // 3. Оплата за результат: раздел платежей — суммы привязаны к этапам.
    //
    // Раньше здесь была денежная ВКЛАДКА договора (`/contracts/:id/money`), но
    // на ширине десктопа карточка рисует свой набор вкладок, и кадр показывал
    // «Overview» — проверено по вырезанному кадру. Раздел платежей отвечает на
    // тот же вопрос («за что и когда платят») и не зависит от того, какая
    // раскладка карточки сейчас активна.
    await chapter('payment', async () => {
      await go(page, '/payments');
      await page.getByTestId('payments-groups').waitFor();
    });

    // 4. Доказательства, которые остаются: замороженная версия и хеш целостности.
    await chapter('evidence', async () => {
      await go(page, '/contracts/rc-awaiting-other-signed-1/sign');
      await page.getByTestId('frozen-version-hash').waitFor();
    });

    // 5. Репутация на фактах: карточка со счётом завершённых сделок.
    await chapter('reputation', async () => {
      await go(page, '/@akovalev');
      await page.getByTestId('card-stats').waitFor();
    });

    // Постер — кадр из первой главы: `<video preload="none">` до нажатия
    // показывает именно его, и это единственное, что грузится у случайного
    // посетителя.
    await go(page, '/contracts/new');
    await page.getByTestId('type-service').waitFor();
    await page.evaluate(() => document.fonts.ready);
    await dropUnrenderableEmoji(page);
    writeFileSync(join(MEDIA_DIR, 'tour-poster.png'), await page.screenshot());

    const video = page.video();
    if (!video) throw new Error('запись не включилась — проверь recordVideo в контексте');
    // Файл дописывается при закрытии контекста, путь известен заранее.
    const rawPath = await video.path();
    await context.close();

    // Срезаем вход и перекодируем в тот же webm/VP8: ffmpeg из поставки
    // Playwright умеет ровно это (других кодеков в нём нет — см. README).
    const outPath = join(MEDIA_DIR, 'tour-en.webm');
    execFileSync(
      ffmpegPath(),
      [
        '-y',
        '-ss', (leadInMs / 1000).toFixed(3),
        '-i', rawPath,
        '-c:v', 'libvpx',
        '-b:v', '1200k',
        '-crf', '33',
        '-an',
        outPath,
      ],
      { stdio: 'pipe' },
    );

    const total = chapters[chapters.length - 1]!.endMs - leadInMs;
    writeFileSync(
      join(MEDIA_DIR, 'tour-chapters.json'),
      `${JSON.stringify(
        {
          // Времена — уже ОТНОСИТЕЛЬНО обрезанного ролика: субтитрам нужен
          // именно он, а не исходная запись со входом.
          video: 'tour-en.webm',
          lang: 'en',
          durationMs: total,
          chapters: chapters.map((c) => ({
            key: c.key,
            startMs: c.startMs - leadInMs,
            endMs: c.endMs - leadInMs,
          })),
        },
        null,
        2,
      )}\n`,
    );

    expect(chapters.map((c) => c.key)).toEqual([
      'contract',
      'stages',
      'payment',
      'evidence',
      'reputation',
    ]);
    expect(total, 'ролик длиннее минуты — это уже не «короткий»').toBeLessThan(70_000);
    renameSync(rawPath, join(RAW_DIR, 'raw-with-login.webm'));
  });
});
