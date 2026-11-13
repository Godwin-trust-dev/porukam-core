import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUNDLED_LOCALE_CODES } from '@porukam/i18n';
import {
  SITE_SHOTS,
  SITE_SHOT_LANGS,
  SITE_SHOT_SIZE,
  siteShotLang,
  siteShotSrc,
} from '../src/features/publicSite/shots';

/**
 * Полоса кадров интерфейса на лендинге (ADR-195, дополнение 30.10).
 *
 * Как и у ролика, конструкция собрана из частей, которые правятся порознь:
 * кадры снимает e2e-спек витрины (`tests/e2e/store-screenshots.spec.ts`),
 * пережимает скрипт (`scripts/ops/build-site-shots.mjs`), а показывает лендинг
 * по списку из `features/publicSite/shots.ts`. Разъехаться они могут молча:
 * переименовали кадр — на странице битая картинка; забыли пережать — в полосу
 * уедет мегабайтный PNG; поправили ключ подписи — под кадром встанет сырой
 * `nav.home`. Ни одно из этих состояний не ломает сборку.
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const SHOTS_DIR = join(ROOT, 'web/public/media/shots');
const LOCALES_DIR = join(ROOT, 'packages/i18n/src/locales');

/**
 * Бюджет одного кадра. 90 КБ — с запасом к нынешним 28–53 КБ и заведомо ниже
 * исходных PNG витрины (230–390 КБ): проверка ловит ровно тот случай, когда
 * в `public/media/shots` кладут неперекодированный кадр.
 */
const MAX_SHOT_BYTES = 90 * 1024;

/**
 * Размер кадра из заголовка WebP. Chromium пишет расширенный контейнер
 * (`VP8X`), но простой (`VP8 `) разбираем тоже: формат зависит от версии
 * браузера, а проверка не должна падать от смены поставки Playwright.
 */
function readWebpSize(file: string): { width: number; height: number } {
  const buf = readFileSync(file);
  expect(buf.subarray(0, 4).toString('ascii'), `${file}: не RIFF`).toBe('RIFF');
  expect(buf.subarray(8, 12).toString('ascii'), `${file}: не WEBP`).toBe('WEBP');
  const chunk = buf.subarray(12, 16).toString('ascii');
  if (chunk === 'VP8X') {
    // 16–19 — размер чанка, 20–23 — флаги, дальше по три байта на сторону
    // холста, записанные «на единицу меньше».
    return { width: buf.readUIntLE(24, 3) + 1, height: buf.readUIntLE(27, 3) + 1 };
  }
  expect(chunk, `${file}: неизвестный контейнер WebP`).toBe('VP8 ');
  // 20–22 — тег кадра, 23–25 — sync-код, дальше 14 бит ширины и 14 бит высоты.
  return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
}

/** Значение ключа вида `contract.tabs.overview` в языковом пакете. */
function translation(locale: string, key: string): unknown {
  const [ns, ...rest] = key.split('.');
  const file = join(LOCALES_DIR, locale, `${ns}.json`);
  if (!existsSync(file)) return undefined;
  let cur: unknown = JSON.parse(readFileSync(file, 'utf8'));
  for (const part of rest) {
    if (typeof cur !== 'object' || cur === null) return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

describe('кадры интерфейса на лендинге', () => {
  it('каждый кадр лежит на месте для обоих языков и укладывается в бюджет', () => {
    for (const lang of SITE_SHOT_LANGS) {
      for (const shot of SITE_SHOTS) {
        const file = join(SHOTS_DIR, lang, shot.file);
        expect(existsSync(file), `нет кадра ${lang}/${shot.file}`).toBe(true);
        expect(statSync(file).size, `${lang}/${shot.file} слишком тяжёлый`).toBeLessThan(
          MAX_SHOT_BYTES,
        );
      }
    }
  });

  it('в папках нет кадров мимо списка — иначе они просто не доедут до страницы', () => {
    const expected = new Set(SITE_SHOTS.map((s) => s.file));
    for (const lang of SITE_SHOT_LANGS) {
      const actual = readdirSync(join(SHOTS_DIR, lang));
      expect(new Set(actual), `состав ${lang}`).toEqual(expected);
    }
  });

  it('размер файла совпадает с тем, что проставлено в разметке', () => {
    // Расхождение здесь — это прыжок страницы при загрузке и раздавленный
    // кадр: браузер резервирует место по атрибутам, а рисует по файлу.
    for (const lang of SITE_SHOT_LANGS) {
      for (const shot of SITE_SHOTS) {
        expect(readWebpSize(join(SHOTS_DIR, lang, shot.file)), `${lang}/${shot.file}`).toEqual(
          SITE_SHOT_SIZE[lang],
        );
      }
    }
  });

  it('подписи взяты из существующих ключей и есть на всех языках сборки', () => {
    // Смысл проверки — не «перевод на месте», а «на лендинге не появилось
    // нового текста»: ключ, которого нет в пакете, означает ровно то, что
    // подпись написали заново и перевести её забыли.
    for (const code of BUNDLED_LOCALE_CODES) {
      for (const shot of SITE_SHOTS) {
        const value = translation(code, shot.captionKey);
        expect(typeof value, `${code}: ключ ${shot.captionKey}`).toBe('string');
        expect((value as string).length, `${code}: пустая подпись ${shot.captionKey}`).toBeGreaterThan(0);
      }
    }
  });

  it('русская страница показывает русские кадры, остальные — английские', () => {
    expect(siteShotLang('ru')).toBe('ru');
    for (const code of BUNDLED_LOCALE_CODES.filter((c) => c !== 'ru')) {
      expect(siteShotLang(code), `${code} берёт английский набор`).toBe('en');
    }
    expect(siteShotSrc('en', '01-home.webp')).toBe('/media/shots/en/01-home.webp');
  });
});
