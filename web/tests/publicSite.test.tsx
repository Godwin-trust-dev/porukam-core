import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { createI18n } from '@porukam/i18n';
import {
  PUBLIC_PAGE_SLUGS,
  allPublicPaths,
  parsePublicPath,
  publicPath,
} from '../src/features/publicSite/pages';
import { publicMeta } from '../src/features/publicSite/meta';
import { ShellOrLanding } from '../src/features/publicSite/ShellOrLanding';
import { publicRoutes } from '../src/features/publicSite/PublicRoutes';
import { initialLocale } from '../src/features/locale/initialLocale';
import { useGuestLocaleStore } from '../src/features/locale/localeStore';
import { useAuthStore } from '../src/features/auth/authStore';

// Признак «мы внутри установленного приложения» подменяем: в jsdom его не
// получить (нет TWA-реферера и standalone-окна), а ветка нужна как раз в тесте.
const wrapper = vi.hoisted(() => ({ value: false }));
vi.mock('../src/features/pwa/appWrapper', async (orig) => ({
  ...(await orig<typeof import('../src/features/pwa/appWrapper')>()),
  isAppWrapper: () => wrapper.value,
}));
// Оболочка приложения тянет половину продукта (запросы, сокеты) — для развилки
// на `/` важно лишь, ПОПАЛИ ли мы в неё, поэтому подменяем маркером.
vi.mock('../src/pages/ShellLayout', () => ({ ShellLayout: () => <div data-testid="app-shell" /> }));
vi.mock('../src/features/auth/RequireGlobalOnboarding', () => ({
  RequireGlobalOnboarding: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

describe('публичный контур — адресная схема (ADR-195)', () => {
  it('апекс английский без префикса, остальные языки — с префиксом', () => {
    // Если en получит префикс, появятся две живые копии страницы (/faq и /en/faq)
    // и поисковик начнёт выбирать между ними.
    expect(publicPath('en', 'faq')).toBe('/faq');
    expect(publicPath('ru', 'faq')).toBe('/ru/faq');
    expect(publicPath('en')).toBe('/');
    expect(publicPath('ru')).toBe('/ru');
  });

  it.each([
    ['/', { locale: 'en' }],
    ['/faq', { locale: 'en', slug: 'faq' }],
    ['/ru', { locale: 'ru' }],
    ['/ru/faq', { locale: 'ru', slug: 'faq' }],
    ['/zh-Hans/about', { locale: 'zh-Hans', slug: 'about' }],
    ['/ru/', { locale: 'ru' }],
  ])('%s — публичный адрес', (path, expected) => {
    expect(parsePublicPath(path)).toEqual(expected);
  });

  it.each([
    ['/contracts', 'маршрут приложения'],
    ['/@ivan', 'публичная карточка репутации живёт в корне'],
    ['/ru/contracts', 'языковой префикс + не-страница'],
    ['/xx/faq', 'неизвестный язык'],
    ['/faq/extra', 'лишний сегмент'],
    ['/en', '/en — не живая копия, роутер редиректит на апекс'],
    ['/en/faq', 'то же для страницы'],
  ])('%s — НЕ публичный контур (%s)', (path) => {
    // Иначе язык маршрутов приложения начнёт определяться адресом, а
    // `/@ivan` или `/contracts` — получать лендинговую рамку.
    expect(parsePublicPath(path)).toBeNull();
  });

  it('allPublicPaths — 29 × 5 = 145 уникальных адресов, и каждый разбирается обратно', () => {
    // Пререндер и sitemap строятся из этого списка: дубль или адрес, который
    // роутер не разберёт, дал бы битую страницу в dist.
    const all = allPublicPaths();
    expect(all).toHaveLength(29 * 5);
    expect(new Set(all.map((p) => p.path)).size).toBe(145);
    for (const p of all) {
      expect(parsePublicPath(p.path)).toEqual(p.slug ? { locale: p.locale, slug: p.slug } : { locale: p.locale });
    }
  });

  it('publicRoutes — маршрутов столько же, сколько адресов (+ редиректы /en)', () => {
    // Роутер и пререндер расходятся молча: проверяем, что каждый адрес из списка
    // имеет маршрут. Считаем листья дерева (индексы и страницы) без /en-алиасов.
    const leaves = publicRoutes().flatMap((r) => (r.children ? r.children.map(() => 1) : r.path?.startsWith('en') ? [] : [1]));
    // апекс: 4 страницы (лендинг на `/` отдаёт ShellOrLanding), 28 языков × 5.
    expect(leaves.length).toBe(4 + 28 * 5);
    expect(PUBLIC_PAGE_SLUGS).toHaveLength(4);
  });
});

describe('initialLocale — язык из адреса', () => {
  beforeEach(() => useGuestLocaleStore.setState({ locale: null as never }));

  it('публичный адрес решает язык, браузер игнорируется', () => {
    // /ru/faq из браузера с de обязан открыться по-русски — как и пререндер.
    expect(initialLocale('de', '/ru/faq')).toBe('ru');
  });
  it('апекс — английский, а не язык браузера', () => {
    expect(initialLocale('de', '/faq')).toBe('en');
  });
  it('не публичный адрес — прежняя логика (язык браузера)', () => {
    expect(initialLocale('de', '/contracts')).toBe('de');
  });
});

describe('publicMeta', () => {
  it('у лендинга и всех страниц непустые заголовок и описание', () => {
    // Пустой title/description в пререндере — страница без сниппета в выдаче.
    const i18n = createI18n('ru');
    for (const slug of [undefined, ...PUBLIC_PAGE_SLUGS]) {
      const m = publicMeta(i18n.t.bind(i18n) as never, slug);
      expect(m.title.trim()).not.toBe('');
      expect(m.description.trim()).not.toBe('');
    }
  });
});

function renderAt(path: string, locale = 'en') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <I18nextProvider i18n={createI18n(locale)}>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="/" element={<ShellOrLanding />} />
            <Route path="/contracts" element={<ShellOrLanding />} />
            <Route path="/welcome" element={<div data-testid="welcome" />} />
            {publicRoutes().map((r, i) => (
              <Route key={i} path={r.path} element={r.element}>
                {r.children?.map((c, j) => (
                  <Route key={j} index={c.index} path={c.path} element={c.element} />
                ))}
              </Route>
            ))}
          </Routes>
        </MemoryRouter>
      </I18nextProvider>
    </QueryClientProvider>,
  );
}

describe('ShellOrLanding — три ответа на `/`', () => {
  beforeEach(() => {
    useAuthStore.getState().logout();
    wrapper.value = false;
  });

  it('гость в браузере видит лендинг', () => {
    renderAt('/');
    expect(screen.getAllByText(/turns a verbal agreement into a legally meaningful contract/).length).toBeGreaterThan(0);
    expect(screen.queryByTestId('app-shell')).toBeNull();
  });

  it('залогиненный видит оболочку, а не лендинг', () => {
    // Иначе каждый вошедший человек получал бы маркетинговую страницу вместо рабочего стола.
    useAuthStore.getState().setTokens({ access: 'a', refresh: 'r' } as never);
    renderAt('/');
    expect(screen.getByTestId('app-shell')).toBeInTheDocument();
    expect(screen.queryByText(/turns a verbal agreement/)).toBeNull();
  });

  it('гость в установленном приложении уходит на /welcome, лендинга нет', () => {
    // Лендинг первым экраном установленного приложения — претензия RuStore
    // «обёртка над сайтом» (ADR-195 §D).
    wrapper.value = true;
    renderAt('/');
    expect(screen.getByTestId('welcome')).toBeInTheDocument();
    expect(screen.queryByText(/turns a verbal agreement/)).toBeNull();
  });

  it('гость на /contracts получает редирект на вход, а не лендинг', () => {
    renderAt('/contracts');
    expect(screen.getByTestId('welcome')).toBeInTheDocument();
    expect(screen.queryByText(/turns a verbal agreement/)).toBeNull();
  });
});

describe('страницы публичного контура рисуются на языке адреса', () => {
  beforeEach(() => useAuthStore.getState().logout());

  it('/ru/faq — русские вопросы справки', () => {
    renderAt('/ru/faq', 'ru');
    expect(screen.getByText('Это бесплатно?')).toBeInTheDocument();
    expect(screen.queryByText('Is it free?')).toBeNull();
  });

  it('/ru — русский лендинг', () => {
    renderAt('/ru', 'ru');
    expect(screen.getAllByText('Договоры между людьми — по-честному').length).toBeGreaterThan(0);
  });

  it('/en/faq редиректит на апекс /faq', () => {
    renderAt('/en/faq', 'en');
    expect(screen.getByTestId('public-faq')).toBeInTheDocument();
  });
});
