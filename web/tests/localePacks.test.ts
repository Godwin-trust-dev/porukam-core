import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  BUNDLED_LOCALE_CODES,
  EAGER_LOCALES,
  UI_NAMESPACES,
  LOCALE_REGISTRY,
  createI18n,
  dirForLocale,
  en,
  loadLocaleResources,
  matchBundledLocale,
} from '@porukam/i18n';
import { detectGuestLocale } from '../src/features/locale/detectLocale';
import { bundledLocaleInfos } from '../src/features/locale/bundledLocales';
import { listLocales } from '../src/mocks/localesDb';

/**
 * Языковые пакеты стартовых поверхностей
 * (docs/tasks/Задача_feat_l10n-launch-surfaces.md §A/§C, ADR-089).
 *
 * Смысл этих тестов — не «строки переведены» (это машинный перевод, проверяет
 * человек), а «правило §0 не может нарушиться молча»: список языков в
 * переключателе, набор ключей в пакете и код языка в пакетах бэкенда обязаны
 * совпадать, иначе выбор языка снова начнёт падать в EN-фолбэк без предупреждения.
 */

const REPO_ROOT = join(__dirname, '..', '..');

/**
 * Плоское представление неймспейса: `contract.card.loading` вместо вложенного
 * объекта. Нужно потому, что часть неймспейсов (`contract`, `contractNew`)
 * вложенные, и поверхностное сравнение `Object.keys` пропустило бы недобитый
 * перевод внутри `card`/`typeForm`.
 */
function flatten(node: unknown, prefix = ''): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    const path = `${prefix}${key}`;
    if (value !== null && typeof value === 'object') Object.assign(out, flatten(value, `${path}.`));
    else out[path] = value as string;
  }
  return out;
}

function packCodes(): string[] {
  return readdirSync(join(REPO_ROOT, 'l10n', 'packs'))
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.slice(0, -'.json'.length))
    .sort();
}

describe('Реестр языков ↔ языковые пакеты бэкенда', () => {
  it('коды реестра совпадают с l10n/packs (и там, и там 29 языков)', () => {
    expect([...BUNDLED_LOCALE_CODES].sort()).toEqual(packCodes());
  });

  it('регион-тэгированные коды не огрублены (pt-BR/zh-Hans, не pt/zh)', () => {
    expect(BUNDLED_LOCALE_CODES).toContain('pt-BR');
    expect(BUNDLED_LOCALE_CODES).toContain('zh-Hans');
    expect(BUNDLED_LOCALE_CODES).not.toContain('pt');
    expect(BUNDLED_LOCALE_CODES).not.toContain('zh');
  });

  it('rtl в реестре совпадает с dirForLocale (один факт — один ответ)', () => {
    for (const locale of LOCALE_REGISTRY) {
      expect(dirForLocale(locale.code)).toBe(locale.rtl ? 'rtl' : 'ltr');
    }
  });

  it('quality реестра совпадает с quality пакета (human для канона/ревью)', () => {
    for (const locale of LOCALE_REGISTRY) {
      const pack = JSON.parse(
        readFileSync(join(REPO_ROOT, 'l10n', 'packs', `${locale.code}.json`), 'utf8'),
      ) as { quality: string; name: string };
      const expected = pack.quality === 'machine' ? 'machine' : 'human';
      expect(locale.quality, locale.code).toBe(expected);
      expect(locale.selfName, locale.code).toBe(pack.name);
    }
  });

  it('каждый язык из реестра несёт юр-документы в пакете (§C: включаем по готовности)', () => {
    for (const code of BUNDLED_LOCALE_CODES) {
      const pack = JSON.parse(
        readFileSync(join(REPO_ROOT, 'l10n', 'packs', `${code}.json`), 'utf8'),
      ) as { legal?: Record<string, unknown> };
      for (const key of ['privacy', 'tos', 'document_notice']) {
        expect(typeof pack.legal?.[key], `${code}.legal.${key}`).toBe('string');
        expect((pack.legal?.[key] as string).trim().length, `${code}.legal.${key}`).toBeGreaterThan(0);
      }
    }
  });
});

describe('Мок-каталог и бандл-фолбэк собираются из реестра', () => {
  it('мок /v1/locales предлагает ровно забандленные языки, все включёнными', () => {
    const mock = listLocales();
    expect(mock.map((l) => l.code).sort()).toEqual([...BUNDLED_LOCALE_CODES].sort());
    expect(mock.every((l) => l.enabled)).toBe(true);
  });

  it('бандл-фолбэк — тот же список (раньше это были жёстко en/ru)', () => {
    expect(bundledLocaleInfos().map((l) => l.code).sort()).toEqual([...BUNDLED_LOCALE_CODES].sort());
  });
});

describe('matchBundledLocale — тег браузера → код пакета', () => {
  it.each([
    ['es', 'es'],
    ['es-419', 'es'],
    ['ES-ES', 'es'],
    ['pt-BR', 'pt-BR'],
    // Браузер говорит `pt`/`pt-PT`, пакет называется `pt-BR` — до этой ветки
    // такой гость уезжал в английский.
    ['pt', 'pt-BR'],
    ['pt-PT', 'pt-BR'],
    ['zh-Hans', 'zh-Hans'],
    ['zh-CN', 'zh-Hans'],
    ['zh', 'zh-Hans'],
  ])('%s → %s', (tag, expected) => {
    expect(matchBundledLocale(tag)).toBe(expected);
  });

  it.each([['sv'], ['xx-YY'], [''], [undefined], [null]])('нет в сборке: %s → undefined', (tag) => {
    expect(matchBundledLocale(tag as string | undefined | null)).toBeUndefined();
  });
});

describe('detectGuestLocale', () => {
  const enabled = [...BUNDLED_LOCALE_CODES];

  it('бразильский гость получает pt-BR, а не en', () => {
    expect(detectGuestLocale('pt-BR', enabled)).toBe('pt-BR');
  });

  it('язык в сборке, но выключенный продуктово → en', () => {
    expect(detectGuestLocale('de', enabled.filter((c) => c !== 'de'))).toBe('en');
  });

  it('включённый язык, которого нет в этой сборке → en (иначе молчаливый EN-фолбэк)', () => {
    expect(detectGuestLocale('sv', [...enabled, 'sv'])).toBe('en');
  });

  it('нет языка браузера → en', () => {
    expect(detectGuestLocale(null, enabled)).toBe('en');
  });
});

describe('loadLocaleResources — ленивая загрузка пакета', () => {
  it('en/ru уже в бандле: true без сети', async () => {
    const i18n = createI18n('ru');
    for (const code of EAGER_LOCALES) {
      expect(await loadLocaleResources(i18n, code)).toBe(true);
    }
  });

  it('ленивый язык догружается и реально переводит стартовый экран', async () => {
    const i18n = createI18n('en');
    expect(i18n.hasResourceBundle('es', 'translation')).toBe(false);

    expect(await loadLocaleResources(i18n, 'es')).toBe(true);
    await i18n.changeLanguage('es');

    expect(i18n.t('auth.googleButton')).toBe('Continuar con Google');
    expect(i18n.t('onboarding.consentsTitle')).toBe('Datos y privacidad');
    expect(i18n.t('common.retry')).toBe('Reintentar');
    // Ни один ключ стартовых поверхностей не остался английским.
    expect(i18n.t('auth.googleButton')).not.toBe(en.auth.googleButton);
  });

  it('язык вне сборки → false (вызывающая сторона решает свой фолбэк)', async () => {
    const i18n = createI18n('en');
    expect(await loadLocaleResources(i18n, 'sv')).toBe(false);
  });

  it('повторный вызов — no-op, пакет не перезагружается', async () => {
    const i18n = createI18n('en');
    await loadLocaleResources(i18n, 'de');
    expect(i18n.hasResourceBundle('de', 'translation')).toBe(true);
    expect(await loadLocaleResources(i18n, 'de')).toBe(true);
  });

  it('ВСЕ 27 ленивых пакетов грузятся и имеют паритет ключей с EN-каноном', async () => {
    const lazy = BUNDLED_LOCALE_CODES.filter((c) => !EAGER_LOCALES.includes(c as 'en' | 'ru'));
    expect(lazy).toHaveLength(27);

    for (const code of lazy) {
      const i18n = createI18n('en');
      expect(await loadLocaleResources(i18n, code), code).toBe(true);
      const pack = i18n.getResourceBundle(code, 'translation') as Record<string, unknown>;

      for (const ns of UI_NAMESPACES) {
        const canon = flatten((en as Record<string, unknown>)[ns]);
        const bundle = flatten(pack[ns]);
        expect(Object.keys(bundle).sort(), `${code}.${ns}`).toEqual(Object.keys(canon).sort());
        for (const key of Object.keys(canon)) {
          expect(typeof bundle[key], `${code}.${ns}.${key}`).toBe('string');
          expect(bundle[key]!.trim().length, `${code}.${ns}.${key}`).toBeGreaterThan(0);
        }
      }
    }
    // 27 языков × 24 неймспейса × 1257 ключей — дефолтных 5 с не хватает.
  }, 60_000);
});

describe('Внутренние маркеры не утекают в микрокопию', () => {
  /**
   * Находка владельца 05.09: подсказка отклонения этапа показывала
   * «…с доказательством (ADR-017)», подсказка удаления аккаунта —
   * «(crypto-shredding, ADR-035)». Номер решения — адрес документа В ЭТОМ
   * репозитории; за экраном он читается как код ошибки.
   *
   * Дублирует `npm run lint:i18n` намеренно: линтер ловит на входе в PR, а
   * этот тест — при обычном `npm test`. Уехало это в 29 локалей сразу, и
   * чинить пришлось все 29 — цена пропуска слишком велика для одной сети.
   */
  const MARKERS = [
    /\bADR-\d+/,
    /\bDEV-\d+(?:_\d+)?/,
    /\btech-spec\b/i,
    /\bdomain-model\b/i,
    /\bdocs\/[a-z]/,
    /§\s*\d/,
    /crypto-?shredding/i,
    /\b(integrity_hash|compute_segment|has_business_status|placed_in_cabinet_at)\b/,
  ];

  it('ни один ключ ни в одной из 29 локалей не несёт ADR/DEV/жаргона', async () => {
    for (const code of BUNDLED_LOCALE_CODES) {
      const i18n = createI18n('en');
      expect(await loadLocaleResources(i18n, code), code).toBe(true);
      const pack = i18n.getResourceBundle(code, 'translation') as Record<string, unknown>;

      for (const ns of UI_NAMESPACES) {
        for (const [key, value] of Object.entries(flatten(pack[ns]))) {
          for (const marker of MARKERS) {
            expect(marker.test(value), `${code}.${ns}.${key}: ${value}`).toBe(false);
          }
        }
      }
    }
  }, 60_000);

  it('смысл двух починенных подсказок сохранён, а не выкинут вместе со ссылкой', () => {
    // Правило «один пункт чек-листа, с доказательством» — это и есть содержание
    // подсказки; уехать должен был только её хвост.
    const hint = en.stage.realRejectHint;
    expect(hint).toMatch(/checklist item/);
    expect(hint).toMatch(/evidence/);
    expect(hint).not.toMatch(/ADR/);

    // Механизм удаления назван словами, а не термином: человек должен понять,
    // что восстановления не будет.
    const del = en.profile.accDeleteFlowText;
    expect(del).toMatch(/encryption keys are destroyed/);
    expect(del).toMatch(/cannot be recovered/);
    // Вторая половина — что ОСТАЁТСЯ после удаления — не пострадала.
    expect(del).toMatch(/Signature hashes and the evidence chain are kept/);
  });
});
