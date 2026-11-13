import { useTranslation } from 'react-i18next';
import { publicMeta } from '../../features/publicSite/meta';
import { usePublicMeta } from '../../features/publicSite/usePublicMeta';
import { HelpAccordion } from '../help/HelpAccordion';
import styles from './PublicSite.module.css';

/**
 * «Как это работает» без входа (ADR-195): сначала механика сделки блоками из
 * витрины (`site.*`), затем 12 инструкций «как сделать X» — те же `help.howItems`,
 * что в справке приложения, той же гармошкой `HelpAccordion`.
 *
 * Гость видит реальные шаги продукта до регистрации: по замыслу публичного
 * контура человек должен понять механику ДО того, как отдаст Google-аккаунт.
 */
export function HowItWorksPage(): JSX.Element {
  const { t } = useTranslation();
  usePublicMeta(publicMeta(t, 'how-it-works'));
  const how = t('help.howItems', { returnObjects: true }) as Array<{ title: string; text: string }>;

  const flow = [
    { key: 'contract', title: t('site.contractTitle'), text: t('site.contractText') },
    { key: 'stages', title: t('site.stagesTitle'), text: t('site.stagesText') },
    { key: 'payment', title: t('site.paymentTitle'), text: t('site.paymentText') },
  ];

  return (
    <div className={styles.page}>
      <h1 className={styles.pageTitle}>{t('help.howTitle')}</h1>
      {flow.map((f) => (
        <section key={f.key} className={styles.block}>
          <h2 className={styles.blockTitle}>{f.title}</h2>
          <p className={styles.blockText}>{f.text}</p>
        </section>
      ))}
      {Array.isArray(how) ? <HelpAccordion items={how} testId="public-how" /> : null}
    </div>
  );
}
