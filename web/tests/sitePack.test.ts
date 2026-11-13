import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BUNDLED_LOCALE_CODES, createI18n, loadLocaleResources, en, ru } from '@porukam/i18n';

/**
 * Неймспейс `site` — тексты публичных страниц, сгенерированные из утверждённой
 * витрины Google Play (scripts/l10n/import-store-listing.mjs).
 *
 * Смысл тестов — не «переведено хорошо», а «сайт и витрина не разъезжаются молча»:
 * набор ключей одинаков на всех 29 языках, заголовок не склеился с телом блока,
 * а русский и английский тексты буква в букву равны `.txt` витрины.
 */

const REPO_ROOT = join(__dirname, '..', '..');

const SITE_KEYS = [
  'hook',
  'problem',
  'contractTitle',
  'contractText',
  'stagesTitle',
  'stagesText',
  'paymentTitle',
  'paymentText',
  'evidenceTitle',
  'evidenceText',
  'reputationTitle',
  'reputationText',
];
const BLOCKS = ['contract', 'stages', 'payment', 'evidence', 'reputation'];

async function siteOf(code: string): Promise<Record<string, string>> {
  if (code === 'en') return en.site as Record<string, string>;
  if (code === 'ru') return ru.site as Record<string, string>;
  const i18n = createI18n('en');
  expect(await loadLocaleResources(i18n, code), code).toBe(true);
  const pack = i18n.getResourceBundle(code, 'translation') as { site: Record<string, string> };
  return pack.site;
}

/** Абзацы полного описания витрины, как их раскладывает скрипт (первые семь). */
function listingParagraphs(playCode: string): string[] {
  const text = readFileSync(join(REPO_ROOT, 'docs', 'ops', 'store-listing', `${playCode}.txt`), 'utf8');
  const full = text.slice(text.indexOf('\nfull:\n') + '\nfull:\n'.length).trim();
  return full.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean).slice(0, 7);
}

describe('Неймспейс site на всех языках', () => {
  it('ровно 12 ключей, все — непустые строки, на каждом из 29 языков', async () => {
    expect(BUNDLED_LOCALE_CODES).toHaveLength(29);
    for (const code of BUNDLED_LOCALE_CODES) {
      const site = await siteOf(code);
      expect(Object.keys(site).sort(), code).toEqual([...SITE_KEYS].sort());
      for (const key of SITE_KEYS) {
        expect(typeof site[key], `${code}.${key}`).toBe('string');
        expect(site[key]!.trim().length, `${code}.${key}`).toBeGreaterThan(0);
      }
    }
    // Таймаут явный: проверка грузит 29 языковых пакетов по очереди и на
    // машине разработчика укладывается в 4.4 с — то есть впритык к дефолтным
    // пяти. Под нагрузкой (параллельные файлы, dev-сервер рядом) она падала
    // не по сути, а по секундомеру. Делить проверку на 29 отдельных it-ов
    // хуже: смысл её в том, что НИ ОДИН язык не отстал, и читать это удобнее
    // одним провалом со списком, чем россыпью.
  }, 20_000);

  it('заголовок короткий, а текст блока длиннее заголовка (разбор не перевёрнут)', async () => {
    for (const code of BUNDLED_LOCALE_CODES) {
      const site = await siteOf(code);
      for (const block of BLOCKS) {
        const title = site[`${block}Title`]!;
        const text = site[`${block}Text`]!;
        expect(title.length, `${code}.${block}Title`).toBeLessThan(80);
        expect(text.length, `${code}.${block}Text`).toBeGreaterThan(title.length);
      }
    }
  });
});

describe('Сайт ↔ витрина Google Play', () => {
  it.each([
    ['ru', 'ru-RU'],
    ['en', 'en-US'],
  ])('%s: ключи site равны абзацам %s.txt (поправили витрину — перегенерируйте)', async (code, playCode) => {
    const site = await siteOf(code);
    const paragraphs = listingParagraphs(playCode);
    expect(site.hook).toBe(paragraphs[0]);
    expect(site.problem).toBe(paragraphs[1]);
    BLOCKS.forEach((block, i) => {
      const [title, ...rest] = paragraphs[2 + i]!.split('\n').map((l) => l.trim()).filter(Boolean);
      expect(site[`${block}Title`], `${code}.${block}Title`).toBe(title);
      expect(site[`${block}Text`], `${code}.${block}Text`).toBe(rest.join(' '));
    });
  });
});
