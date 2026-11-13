import { useTranslation } from 'react-i18next';
import { publicMeta } from '../../features/publicSite/meta';
import { usePublicMeta } from '../../features/publicSite/usePublicMeta';
import styles from './PublicSite.module.css';

/**
 * «Что такое Porukam» без входа (ADR-195). Текст — те же ключи `help.about*`,
 * что видит человек внутри приложения на `/help/about`: один рассказ о продукте
 * на обе поверхности, переведённый на 29 языков.
 *
 * Здесь же — АТРИБУЦИЯ GeoNames. Справочник гео (ADR-179) распространяется под
 * CC BY 4.0, лицензия требует указания источника на публичной странице «О
 * проекте»; страницы до этой ветки не существовало, и требование висело долгом.
 */
export function AboutPublicPage(): JSX.Element {
  const { t } = useTranslation();
  usePublicMeta(publicMeta(t, 'about'));
  const sections = t('help.aboutSections', { returnObjects: true }) as Array<{ title: string; text: string }>;

  return (
    <div className={styles.page}>
      <h1 className={styles.pageTitle}>{t('help.aboutTitle')}</h1>
      <p className={styles.lead}>{t('help.aboutLead')}</p>
      {Array.isArray(sections)
        ? sections.map((s) => (
            <section key={s.title} className={styles.block}>
              <h2 className={styles.blockTitle}>{s.title}</h2>
              <p className={styles.blockText}>{s.text}</p>
            </section>
          ))
        : null}
      <section className={styles.block}>
        <h2 className={styles.blockTitle}>{t('site.reputationTitle')}</h2>
        <p className={styles.blockText}>{t('site.reputationText')}</p>
      </section>
      <p className={styles.attribution}>
        Geographic data: <a href="https://www.geonames.org/">GeoNames</a>, licensed under{' '}
        <a href="https://creativecommons.org/licenses/by/4.0/">CC BY 4.0</a>.
      </p>
    </div>
  );
}
