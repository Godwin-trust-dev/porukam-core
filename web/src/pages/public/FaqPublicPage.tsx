import { useTranslation } from 'react-i18next';
import { publicMeta } from '../../features/publicSite/meta';
import { usePublicMeta } from '../../features/publicSite/usePublicMeta';
import { HelpAccordion } from '../help/HelpAccordion';
import styles from './PublicSite.module.css';

/**
 * Публичный FAQ (ADR-195) — те же 14 вопросов `help.faqItems`, что в справке
 * приложения. Ровно они отвечают на всё, что спрашивает гость перед входом:
 * бесплатно ли, есть ли у договора юридическая сила, проходят ли деньги через
 * платформу, где лежат файлы, как удалить аккаунт.
 */
export function FaqPublicPage(): JSX.Element {
  const { t } = useTranslation();
  usePublicMeta(publicMeta(t, 'faq'));
  const faq = t('help.faqItems', { returnObjects: true }) as Array<{ q: string; a: string }>;

  return (
    <div className={styles.page}>
      <h1 className={styles.pageTitle}>{t('help.faqTitle')}</h1>
      {Array.isArray(faq) ? (
        <HelpAccordion items={faq.map((it) => ({ title: it.q, text: it.a }))} testId="public-faq" />
      ) : null}
    </div>
  );
}
