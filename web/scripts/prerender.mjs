#!/usr/bin/env node
/**
 * Пререндер публичного контура (ADR-196): 29 языков × (лендинг + 4 страницы)
 * = 145 статических HTML рядом с оболочкой SPA.
 *
 * Зачем вообще. Краулеры мессенджеров (Telegram, WhatsApp, VK) НЕ исполняют
 * JS: до пререндера любая расшаренная ссылка показывала оболочку SPA с одним
 * og:description на весь домен, на каком бы языке страница ни была. Google
 * JS отрендерит, но новый домен индексирует неохотно, а 29 языковых версий
 * без отдельных HTML для него не существуют вовсе.
 *
 * Запускается ПОСЛЕ `vite build` и `vite build --ssr` (см. web/package.json):
 * клиентская сборка даёт шаблон `dist/index.html` с правильными хешами
 * бандлов, SSR-сборка — функцию рендера. Своего шаблона скрипт не держит:
 * иначе ссылки на бандлы разъехались бы с первой же сборкой.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const DIST = join(WEB_DIR, 'dist');
const SSR_ENTRY = join(WEB_DIR, 'dist-ssr', 'entry-prerender.js');

/** Боевой origin — он уезжает в canonical/og:url/hreflang, поэтому абсолютный. */
const ORIGIN = process.env.SITE_ORIGIN ?? 'https://porukam.app';

/**
 * Снятие мерцания у тех, кому лендинг не предназначен.
 *
 * nginx отдаёт `landing.html` на `/` всем подряд — он не знает, кто пришёл.
 * Залогиненный человек и установленное приложение получат тот же файл, и до
 * монтирования SPA (а оно ждёт языковой чанк) видели бы маркетинговый текст
 * вместо своего рабочего стола. Решение «что показать» остаётся в React
 * (`ShellOrLanding`, ADR-195), здесь только прячем статику, чтобы не мигала:
 * React при первом рендере всё равно вычистит контейнер.
 *
 * Признак входа — тот же ключ localStorage, в котором живёт сессия
 * (`porukam.auth`, `features/auth/authStore.ts`). Признак установленного
 * приложения — параметр `src` стартового адреса (`?src=pwa` / `?src=twa`,
 * ADR-176). Всё в try/catch: приватный режим не должен ломать страницу.
 */
const BOOT_SCRIPT = `<style>.pr-boot #pr-static{display:none}</style>
<script>(function(){try{var h=document.documentElement;if(new URL(location.href).searchParams.get('src')){h.className+=' pr-boot';return;}var raw=localStorage.getItem('porukam.auth');if(raw&&JSON.parse(raw).state&&JSON.parse(raw).state.isAuthenticated){h.className+=' pr-boot';}}catch(e){}})();</script>`;

function escapeAttr(value) {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function buildHead({ title, description, lang, path, alternates }) {
  const canonical = `${ORIGIN}${path}`;
  const hreflang = alternates
    .map((a) => `    <link rel="alternate" hreflang="${a.lang}" href="${ORIGIN}${a.path}" />`)
    .join('\n');
  return [
    `    <meta name="description" content="${escapeAttr(description)}" />`,
    `    <link rel="canonical" href="${canonical}" />`,
    `    <meta property="og:url" content="${canonical}" />`,
    `    <meta property="og:locale" content="${lang}" />`,
    hreflang,
  ].join('\n');
}

async function main() {
  const { renderPublicPage, allPublicPaths, APEX_LOCALE } = await import(SSR_ENTRY);
  const template = readFileSync(join(DIST, 'index.html'), 'utf8');
  const pages = allPublicPaths();

  // Альтернативы hreflang считаются по СЛАГУ: у каждой страницы 29 языковых
  // версий плюс `x-default` на апекс (английский) — на него уходит трафик с
  // языков, которых у нас нет.
  const bySlug = new Map();
  for (const page of pages) {
    const key = page.slug ?? '';
    if (!bySlug.has(key)) bySlug.set(key, []);
    bySlug.get(key).push(page);
  }

  let written = 0;
  for (const page of pages) {
    const { html, title, description, lang, dir } = await renderPublicPage(page.path, page.locale, page.slug);
    if (!html || html.length < 200) throw new Error(`пустой рендер: ${page.path}`);
    if (!title || !description) throw new Error(`нет заголовка/описания: ${page.path}`);

    const siblings = bySlug.get(page.slug ?? '');
    const alternates = [
      ...siblings.map((s) => ({ lang: s.locale, path: s.path })),
      { lang: 'x-default', path: siblings.find((s) => s.locale === APEX_LOCALE).path },
    ];

    let out = template
      .replace(/<html lang="[^"]*" dir="[^"]*">/, `<html lang="${lang}" dir="${dir}">`)
      .replace(/<title>[^<]*<\/title>/, `<title>${escapeAttr(title)} · Porukam</title>`)
      .replace(
        /(<meta\s+property="og:description"\s+content=")[^"]*(")/,
        (_m, a, b) => `${a}${escapeAttr(description)}${b}`,
      )
      // og:title — тоже на страницу, а не один на домен: в превью ссылки
      // мессенджер показывает его крупным, и «Porukam» на всех 145 адресах
      // означал бы 145 одинаковых карточек.
      .replace(
        /(<meta\s+property="og:title"\s+content=")[^"]*(")/,
        (_m, a, b) => `${a}${escapeAttr(title)}${b}`,
      )
      .replace('</head>', `${buildHead({ title, description, lang, path: page.path, alternates })}\n${BOOT_SCRIPT}\n  </head>`)
      .replace('<div id="root"></div>', `<div id="root"><div id="pr-static">${html}</div></div>`);

    // Замены выше идут по регуляркам, а разметка в шаблоне многострочная
    // (prettier переносит атрибуты) — поэтому проверяем РЕЗУЛЬТАТ, а не веру.
    // Каждый тег ищется отдельно: промах ровно одного из них — самый вероятный
    // и самый тихий способ уехать в прод с чужим языком в превью ссылки.
    const assertMeta = (re, what) => {
      const found = out.match(re);
      if (!found || !found[0].includes(escapeAttr(what))) {
        throw new Error(`не подставлено (${re.source}): ${page.path}`);
      }
    };
    assertMeta(/<meta\s+property="og:description"\s+content="[^"]*"/, description);
    assertMeta(/<meta\s+property="og:title"\s+content="[^"]*"/, title);
    assertMeta(/<meta\s+name="description"\s+content="[^"]*"/, description);
    if (!out.includes('id="pr-static"')) throw new Error(`разметка не вставлена: ${page.path}`);

    // `/` → landing.html (nginx отдаёт его точным совпадением `location = /`,
    // а оболочка SPA остаётся в index.html для всех клиентских маршрутов).
    const file =
      page.path === '/' ? join(DIST, 'landing.html') : join(DIST, page.path.replace(/^\//, ''), 'index.html');
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, out, 'utf8');
    written += 1;
  }

  // sitemap: только адреса. Языковые соответствия (`hreflang`) печатаются в
  // <head> каждой страницы — дублировать их здесь значило бы вести два списка
  // одного и того же и получить расхождение.
  const lastmod = new Date().toISOString().slice(0, 10);
  const urls = pages
    .map((p) => `  <url>\n    <loc>${ORIGIN}${p.path}</loc>\n    <lastmod>${lastmod}</lastmod>\n  </url>`)
    .join('\n');
  writeFileSync(
    join(DIST, 'sitemap.xml'),
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`,
    'utf8',
  );

  console.log(`✓ пререндер: ${written} страниц, sitemap на ${pages.length} адресов`);
}

main().catch((err) => {
  console.error('✗ пререндер упал:', err);
  process.exit(1);
});
