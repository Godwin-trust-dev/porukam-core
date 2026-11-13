import { renderToStaticMarkup } from 'react-dom/server';
import { I18nextProvider, useTranslation } from 'react-i18next';
import { StaticRouter } from 'react-router-dom/server';
import { useRoutes } from 'react-router-dom';
import { createI18n, dirForLocale, loadLocaleResources } from '@porukam/i18n';
import { publicMeta } from './features/publicSite/meta';
import { publicRoutes } from './features/publicSite/PublicRoutes';
import type { PublicPageSlug } from './features/publicSite/pages';
import { LandingPage } from './pages/public/LandingPage';
import { PublicLayout } from './pages/public/PublicLayout';

/**
 * Точка входа ПРЕРЕНДЕРА (ADR-196) — рисует публичные страницы в node при
 * сборке. Собирается отдельной SSR-сборкой vite, в бандл пользователя не
 * попадает.
 *
 * Здесь нет ни `QueryClientProvider`, ни мок-слоя, ни регистрации service
 * worker'а — и это не упрощение, а требование к публичному контуру: страницы
 * обязаны рисоваться из одного бандла, без единого запроса к бэкенду (см.
 * `PublicLayout`). Если однажды на публичной странице появится хук с запросом,
 * сборка упадёт здесь — и это правильное место для такого отказа.
 */
function PublicTree(): JSX.Element | null {
  return useRoutes(publicRoutes());
}

/** Лендинг апекса (`/`) в приложении рисует `ShellOrLanding`, а не route-элемент. */
function ApexLanding(): JSX.Element {
  return (
    <PublicLayout>
      <LandingPage />
    </PublicLayout>
  );
}

function Meta({ slug, onReady }: { slug?: PublicPageSlug; onReady: (m: { title: string; description: string }) => void }): null {
  const { t } = useTranslation();
  onReady(publicMeta(t, slug));
  return null;
}

export interface PrerenderResult {
  html: string;
  title: string;
  description: string;
  lang: string;
  dir: 'ltr' | 'rtl';
}

export async function renderPublicPage(path: string, locale: string, slug?: PublicPageSlug): Promise<PrerenderResult> {
  const i18n = createI18n(locale);
  // Пакет языка — тем же путём, что в браузере (`applyLocale`): сначала
  // загрузить чанк, потом переключить язык. 27 из 29 языков лежат ленивыми
  // чанками, и без загрузки страница собралась бы по EN-фолбэку — то есть
  // пререндер молча выдал бы 29 английских копий.
  await loadLocaleResources(i18n, locale);
  if (i18n.language !== locale) await i18n.changeLanguage(locale);

  let meta = { title: '', description: '' };
  const tree = (
    <StaticRouter location={path}>
      <I18nextProvider i18n={i18n}>
        <Meta slug={slug} onReady={(m) => (meta = m)} />
        {path === '/' ? <ApexLanding /> : <PublicTree />}
      </I18nextProvider>
    </StaticRouter>
  );

  const html = renderToStaticMarkup(tree);
  return { html, title: meta.title, description: meta.description, lang: locale, dir: dirForLocale(locale) };
}

// Реестр адресов — наружу из этого же бандла: скрипту пререндера не нужно
// разбирать TS самому, а список остаётся ОДИН (роутер, пререндер, sitemap).
export { APEX_LOCALE, allPublicPaths } from './features/publicSite/pages';
