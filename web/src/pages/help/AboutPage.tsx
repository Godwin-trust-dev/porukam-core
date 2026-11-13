import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { Button, Icon, ScreenHeader, SectionLabel } from '@porukam/ui';
import { SocialLinks } from '../../features/social-links/SocialLinks';
import {
  PARENT_COMPANY_NAME,
  parentCompanyUrl,
} from '../../shared/parentCompany';
import { HelpAccordion } from './HelpAccordion';
import styles from './HelpPage.module.css';

/**
 * «Что такое По рукам» (отсмотр 2026-08-22): простое описание проекта и
 * инструкции «как сделать X». Тексты — неймспейс `help` (l10n).
 *
 * Замечание владельца 03.09 (дословно): «текст компактно, мельче, без рамок
 * и лишних отступов, в едином стиле с новым дизайном». Абзацы больше не
 * лежат каждый в своей карточке: раздел — подпись + текст 15/13 по
 * density-токенам (ADR-152), инструкции — `Disclosure` на одной поверхности.
 */
export function AboutPage(): JSX.Element {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const sections = t('help.aboutSections', { returnObjects: true }) as Array<{ title: string; text: string }>;
  const how = t('help.howItems', { returnObjects: true }) as Array<{ title: string; text: string }>;
  return (
    <div className={styles.page}>
      <ScreenHeader
        title={t('help.aboutTitle')}
        back={
          <button type="button" className={styles.back} onClick={() => navigate('/me')} aria-label={t('help.backToProfile')}>
            <Icon name="back" size={20} directional />
          </button>
        }
      />
      <p className={styles.lead}>{t('help.aboutLead')}</p>
      {Array.isArray(sections)
        ? sections.map((s) => (
            <section key={s.title} className={styles.section}>
              <h2 className={styles.sectionTitle}>{s.title}</h2>
              <p className={styles.text}>{s.text}</p>
            </section>
          ))
        : null}
      <section className={styles.section}>
        <SectionLabel>{t('help.howTitle')}</SectionLabel>
        {Array.isArray(how) ? <HelpAccordion items={how} testId="help-how" /> : null}
      </section>
      <div className={styles.links}>
        <Button variant="secondary" size="sm" onClick={() => navigate('/help/faq')}>
          {t('help.faqTitle')}
        </Button>
      </div>
      <SocialLinks title={t('help.socialTitle')} />
      {/* Та же подпись, что в подвале публичного контура: кто сделал продукт
          и где про это почитать. Здесь она нужна отдельно — внутрь
          приложения заходят, минуя витрину (установленное приложение
          открывается на `/welcome`, ADR-195), и подвала с ней тут нет.
          Язык ссылки — язык интерфейса, а не адреса страницы. */}
      <p className={styles.madeBy}>
        <a
          href={parentCompanyUrl(i18n.language)}
          target="_blank"
          rel="noopener noreferrer"
        >
          {t('common.madeBy', { brand: PARENT_COMPANY_NAME })}
        </a>
      </p>
    </div>
  );
}
