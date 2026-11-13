import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, Outlet, useLocation } from 'react-router-dom';
import { LanguageSwitcher, Logo } from '@porukam/ui';
import { bundledLocaleInfos } from '../../features/locale/bundledLocales';
import { useGuestLocaleStore } from '../../features/locale/localeStore';
import { PUBLIC_PAGE_SLUGS, parsePublicPath, publicPath } from '../../features/publicSite/pages';
import { PARENT_COMPANY_NAME, parentCompanyUrl } from '../../shared/parentCompany';
import { SocialLinks } from '../../features/social-links/SocialLinks';
import styles from './PublicSite.module.css';

/**
 * Рамка публичного контура (ADR-195): шапка гостя, подвал, язык в адресе.
 *
 * Почему здесь НЕТ ни одного запроса к API (в отличие от `useLanguageSwitcherProps`,
 * который тянет `GET /v1/locales`): страницы этого контура пререндерятся в статические
 * файлы (`web/scripts/prerender.mjs`) и обязаны рисоваться целиком из бандла — и в
 * node при сборке, и у гостя до того, как бэкенд ответит. Список языков берём из
 * реестра сборки (`bundledLocaleInfos`): он и есть правда о том, какие пакеты
 * переведены, а продуктовый рубильник `enabled` на витрине проекта ничего не решает.
 *
 * Переключение языка на публичной странице меняет АДРЕС (`/ru/faq` ↔ `/faq`), а не
 * только состояние i18n: у каждой языковой версии свой индексируемый URL и свой
 * `hreflang`, иначе пререндер и адресная строка разойдутся.
 */
export function PublicLayout({ children }: { children?: ReactNode }): JSX.Element {
  const { t } = useTranslation();
  const { pathname } = useLocation();
  const setGuestLocale = useGuestLocaleStore((s) => s.setLocale);
  const here = parsePublicPath(pathname) ?? { locale: 'en' };

  const navItems: Array<{ slug: (typeof PUBLIC_PAGE_SLUGS)[number]; label: string }> = [
    { slug: 'about', label: t('help.aboutTitle') },
    { slug: 'how-it-works', label: t('help.howTitle') },
    { slug: 'trust', label: t('site.evidenceTitle') },
    { slug: 'faq', label: t('help.faqTitle') },
  ];

  return (
    /* `cozy` — плотность «якорей» (DEV-20 §7), та же, что у входа и церемонии
       приёмки. По умолчанию density-слой `--pr-d-*` стоит в `compact`: он
       рассчитан на рабочие экраны со списками сделок, где воздух — потерянные
       строки. Витрина — противоположная задача: 13px вторичного текста и 12px
       между секциями читаются на десктопе как сжатая телефонная страница. */
    <div className={styles.site} data-density="cozy">
      <header className={styles.header}>
        <Link to={publicPath(here.locale)} className={styles.brand} aria-label={t('common.appName')}>
          <Logo variant="full" on="light" size={28} wordmark={t('common.appName')} />
        </Link>
        <nav className={styles.nav} aria-label={t('help.aboutTitle')}>
          {navItems.map((item) => (
            <Link
              key={item.slug}
              to={publicPath(here.locale, item.slug)}
              className={styles.navLink}
              aria-current={here.slug === item.slug ? 'page' : undefined}
            >
              {item.label}
            </Link>
          ))}
        </nav>
        <div className={styles.headerActions}>
          <LanguageSwitcher
            variant="globe"
            isGuest
            locales={bundledLocaleInfos()}
            currentLocale={here.locale}
            // Выбор языка = ПЕРЕХОД на языковую версию этой же страницы, а не
            // смена состояния i18n: у каждой версии свой индексируемый адрес и
            // свой пререндеренный HTML. Переключать язык в памяти не нужно —
            // новая страница определит его по адресу (`initialLocale`).
            //
            // Общий `usePickLocale` здесь НЕ подходит: он умеет и про
            // залогиненного (PATCH языка в профиль) и потому тянет за собой
            // react-query. Публичная страница обязана рисоваться без клиента
            // запросов вообще — иначе она не пререндерится (ADR-196 §A).
            // Выбор запоминаем в сессии гостя, чтобы язык не сбросился при
            // входе в приложение кнопкой рядом.
            onPick={(code) => {
              setGuestLocale(code);
              window.location.assign(publicPath(code, here.slug));
            }}
            listTitle={t('locale.listTitle')}
            searchPlaceholder={t('locale.searchPlaceholder')}
            searchAriaLabel={t('locale.searchAriaLabel')}
            searchClearLabel={t('locale.searchClear')}
            retryLabel={t('locale.loadErrorRetry')}
            currentSectionTitle={t('locale.currentSectionTitle')}
            allSectionTitle={t('locale.allSectionTitle')}
            noResultsText={t('locale.noResults')}
            betaLabel={t('locale.betaBadge')}
            betaTooltip={t('locale.betaTooltip')}
            currentAriaLabel={t('locale.currentAria')}
            closeLabel={t('locale.closeLabel')}
            triggerAriaLabel={t('locale.globeTriggerAria')}
          />
          <a className={styles.loginLink} href="/welcome">
            {t('auth.title')}
          </a>
        </div>
      </header>

      <main className={styles.main}>
        {/* Обычно рамка — layout-маршрут и содержимое приходит через `Outlet`.
            `children` нужен одному вызову: `ShellOrLanding` на `/` решает
            «лендинг или оболочка приложения» сам и рисует страницу напрямую
            (у того адреса не может быть двух route-элементов). */}
        {children ?? <Outlet />}
      </main>

      <footer className={styles.footer}>
        <div className={styles.footerLinks}>
          {/* Юр-документы — отдельными публичными страницами с языком в ссылке
              (требование магазинов, см. router.tsx): `?lang=` там уже конвенция. */}
          <a href={`/legal/terms?lang=${here.locale}`}>{t('auth.tosLinkLabel')}</a>
          <a href={`/legal/privacy?lang=${here.locale}`}>{t('auth.privacyLinkLabel')}</a>
          <a href={`/legal/account-deletion?lang=${here.locale}`}>{t('legal.accountDeletion.title')}</a>
        </div>
        <SocialLinks title={t('help.socialTitle')} />
        <p className={styles.footerNote}>{t('site.hook')}</p>
        {/* Авторство продукта: «По рукам» сделан Trust Dev, у компании
            есть свой сайт о её деятельности. Ссылка внешняя и уводит с сайта,
            поэтому `target="_blank"` + `rel="noopener noreferrer"` — та же
            конвенция, что у иконок соцсетей выше. Язык версии выбирает
            `parentCompanyUrl`: у их сайта пока только английский и русский. */}
        <p className={styles.madeBy}>
          <a href={parentCompanyUrl(here.locale)} target="_blank" rel="noopener noreferrer">
            {t('common.madeBy', { brand: PARENT_COMPANY_NAME })}
          </a>
        </p>
      </footer>
    </div>
  );
}
