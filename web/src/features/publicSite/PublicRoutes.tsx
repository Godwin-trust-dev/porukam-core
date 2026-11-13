import { Navigate, type RouteObject } from 'react-router-dom';
import { AboutPublicPage } from '../../pages/public/AboutPublicPage';
import { FaqPublicPage } from '../../pages/public/FaqPublicPage';
import { HowItWorksPage } from '../../pages/public/HowItWorksPage';
import { LandingPage } from '../../pages/public/LandingPage';
import { PublicLayout } from '../../pages/public/PublicLayout';
import { TrustPage } from '../../pages/public/TrustPage';
import { APEX_LOCALE, PREFIXED_LOCALES, type PublicPageSlug } from './pages';

/** Страница по слагу — один список для роутера и для пререндера. */
export const PUBLIC_PAGE_ELEMENTS: Record<PublicPageSlug, JSX.Element> = {
  about: <AboutPublicPage />,
  'how-it-works': <HowItWorksPage />,
  trust: <TrustPage />,
  faq: <FaqPublicPage />,
};

const PAGE_ROUTES: RouteObject[] = (Object.keys(PUBLIC_PAGE_ELEMENTS) as PublicPageSlug[]).map((slug) => ({
  path: slug,
  element: PUBLIC_PAGE_ELEMENTS[slug],
}));

/**
 * Маршруты публичного контура (ADR-195).
 *
 * Собираются списком, а не вручную: 29 языков × (лендинг + 4 страницы) = 145
 * адресов, и писать их в роутере поштучно значило бы гарантированно разойтись
 * с пререндером при добавлении языка или страницы.
 *
 * Апекс — английский (решение владельца 29.10): `/about` без префикса. Поэтому
 * языковые маршруты объявляются СТАТИЧЕСКИМИ путями `/<код>/...`, а не одним
 * `/:locale/...`: статический сегмент в React Router v6 приоритетнее
 * параметра, и `/ru` не может перехватить публичная карточка репутации
 * `/:handle`, которая живёт в корне (её проверка «@» — внутри страницы).
 * Явный `/en/*` НЕ объявляется живой копией, а редиректит на апекс: две
 * страницы с одним текстом конкурировали бы в выдаче между собой.
 */
export function publicRoutes(): RouteObject[] {
  const apex: RouteObject = {
    element: <PublicLayout />,
    children: PAGE_ROUTES,
  };

  const localized: RouteObject[] = PREFIXED_LOCALES.map((code) => ({
    path: code,
    element: <PublicLayout />,
    children: [{ index: true, element: <LandingPage /> }, ...PAGE_ROUTES],
  }));

  const apexAliases: RouteObject[] = [
    { path: APEX_LOCALE, element: <Navigate to="/" replace /> },
    ...(Object.keys(PUBLIC_PAGE_ELEMENTS) as PublicPageSlug[]).map((slug) => ({
      path: `${APEX_LOCALE}/${slug}`,
      element: <Navigate to={`/${slug}`} replace />,
    })),
  ];

  return [apex, ...localized, ...apexAliases];
}
