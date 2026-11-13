import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUNDLED_LOCALE_CODES } from '@porukam/i18n';

/**
 * Ролик публичного контура и его субтитры (ADR-195, решение владельца 29.10:
 * «только английский, остальное субтитры»).
 *
 * Проверка нужна потому, что три части этой конструкции живут в разных местах
 * и правятся по отдельности: ролик снимает e2e-спек (`tests/e2e/site-video.spec.ts`),
 * субтитры собирает скрипт (`scripts/l10n/build-video-captions.mjs`), а
 * подключает их лендинг (`pages/public/LandingPage.tsx`). Разъехаться они могут
 * молча: добавили 30-й язык — у него нет дорожки, и человек смотрит ролик на
 * чужом языке без единого слова; пересняли ролик длиннее — субтитры обрываются
 * на середине; переименовали блок витрины — глава осталась без текста.
 * Ни одно из этих состояний не ломает сборку и не видно на глаз.
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const MEDIA = join(ROOT, 'web/public/media');
const CAPTIONS = join(MEDIA, 'captions');

type Plan = {
  video: string;
  lang: string;
  durationMs: number;
  chapters: Array<{ key: string; startMs: number; endMs: number }>;
};

const plan = JSON.parse(readFileSync(join(MEDIA, 'tour-chapters.json'), 'utf8')) as Plan;

/** `00:00:02.600 --> 00:00:09.002` → миллисекунды. */
function parseCues(vtt: string): Array<{ from: number; to: number; text: string }> {
  const cues: Array<{ from: number; to: number; text: string }> = [];
  const lines = vtt.split('\n');
  const ms = (t: string): number => {
    const [h, m, rest] = t.split(':');
    const [s, f] = rest!.split('.');
    return ((Number(h) * 60 + Number(m)) * 60 + Number(s)) * 1000 + Number(f);
  };
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (!line.includes('-->')) continue;
    const [from, to] = line.split('-->').map((x) => x.trim());
    cues.push({ from: ms(from!), to: ms(to!), text: (lines[i + 1] ?? '').trim() });
  }
  return cues;
}

describe('ролик публичного контура и субтитры', () => {
  it('ролик, постер и план глав лежат на месте', () => {
    expect(existsSync(join(MEDIA, plan.video)), plan.video).toBe(true);
    expect(existsSync(join(MEDIA, 'tour-poster.png')), 'постер').toBe(true);
    // Ролик обязан оставаться коротким: владелец просил «короткий видосик»,
    // и это же бюджет трафика у посетителя лендинга.
    expect(plan.durationMs).toBeLessThan(70_000);
    expect(plan.lang, 'язык интерфейса в кадре').toBe('en');
  });

  it('главы идут подряд, без дыр и нахлёстов, и покрывают весь ролик', () => {
    let cursor = 0;
    for (const ch of plan.chapters) {
      expect(ch.startMs, `глава ${ch.key} начинается там, где кончилась прошлая`).toBe(cursor);
      expect(ch.endMs).toBeGreaterThan(ch.startMs);
      cursor = ch.endMs;
    }
    expect(cursor).toBe(plan.durationMs);
  });

  it('у каждого языка сборки есть дорожка субтитров', () => {
    const files = new Set(readdirSync(CAPTIONS));
    for (const code of BUNDLED_LOCALE_CODES) {
      expect(files.has(`${code}.vtt`), `нет субтитров для ${code}`).toBe(true);
    }
  });

  it('реплики не выходят за ролик, не наезжают друг на друга и не пустые', () => {
    for (const code of BUNDLED_LOCALE_CODES) {
      const cues = parseCues(readFileSync(join(CAPTIONS, `${code}.vtt`), 'utf8'));
      expect(cues.length, `${code}: реплик нет вовсе`).toBeGreaterThanOrEqual(
        plan.chapters.length,
      );
      let prevEnd = 0;
      for (const cue of cues) {
        expect(cue.from, `${code}: реплика начинается раньше предыдущей`).toBeGreaterThanOrEqual(
          prevEnd,
        );
        expect(cue.to, `${code}: реплика длиннее ролика`).toBeLessThanOrEqual(plan.durationMs);
        expect(cue.text.length, `${code}: пустая реплика`).toBeGreaterThan(0);
        prevEnd = cue.to;
      }
    }
  });

  it('текст субтитров взят из витрины, а не написан заново', () => {
    // Берём en и ru: обе витрины утверждены владельцем дословно (en — 07.09,
    // ru — оригинал). Если кто-то когда-нибудь впишет в субтитры «свой»
    // текст, проверка это поймает — а значит, у продукта не появится третьего
    // описания помимо магазина и лендинга.
    for (const code of ['en', 'ru']) {
      const site = JSON.parse(
        readFileSync(join(ROOT, `packages/i18n/src/locales/${code}/site.json`), 'utf8'),
      ) as Record<string, string>;
      const cues = parseCues(readFileSync(join(CAPTIONS, `${code}.vtt`), 'utf8'));
      for (const cue of cues) {
        const fromStore = Object.entries(site).some(
          ([key, value]) =>
            (key.endsWith('Title') && value === cue.text) ||
            (key.endsWith('Text') && value.startsWith(cue.text)),
        );
        expect(fromStore, `${code}: реплика «${cue.text}» не из неймспейса site`).toBe(true);
      }
    }
  });
});
