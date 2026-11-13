import { useTranslation } from 'react-i18next';
import { publicMeta } from '../../features/publicSite/meta';
import { usePublicMeta } from '../../features/publicSite/usePublicMeta';
import { HelpAccordion } from '../help/HelpAccordion';
import styles from './PublicSite.module.css';

/**
 * «Доказательства, которые сохранятся» (ADR-195) — страница про то, чем наша
 * фиксация отличается от переписки в мессенджере: метка времени, неизменность
 * подписанного текста, допсоглашение, репутация на фактах.
 *
 * Содержимое собрано ТОЛЬКО из уже утверждённых и переведённых строк: блок
 * витрины `site.evidence*`/`site.reputation*` и те вопросы FAQ приложения,
 * которые отвечают ровно на это (юридическая сила, где лежат файлы,
 * изменение подписанного договора). Выбираем их по ИНДЕКСАМ, потому что
 * `help.faqItems` — массив на 29 языках, и искать «нужный вопрос» по тексту
 * заголовка значило бы завязаться на русскую формулировку.
 */
const FAQ_INDEXES_ABOUT_EVIDENCE = [1, 4, 6] as const;

export function TrustPage(): JSX.Element {
  const { t } = useTranslation();
  usePublicMeta(publicMeta(t, 'trust'));
  const faq = t('help.faqItems', { returnObjects: true }) as Array<{ q: string; a: string }>;
  const picked = Array.isArray(faq)
    ? FAQ_INDEXES_ABOUT_EVIDENCE.map((i) => faq[i]).filter((it): it is { q: string; a: string } => Boolean(it))
    : [];

  return (
    <div className={styles.page}>
      <h1 className={styles.pageTitle}>{t('site.evidenceTitle')}</h1>
      <p className={styles.lead}>{t('site.evidenceText')}</p>
      <section className={styles.block}>
        <h2 className={styles.blockTitle}>{t('site.reputationTitle')}</h2>
        <p className={styles.blockText}>{t('site.reputationText')}</p>
      </section>
      <section className={styles.block}>
        <h2 className={styles.blockTitle}>{t('site.paymentTitle')}</h2>
        <p className={styles.blockText}>{t('site.paymentText')}</p>
      </section>
      {picked.length > 0 ? (
        <HelpAccordion items={picked.map((it) => ({ title: it.q, text: it.a }))} testId="public-trust-faq" />
      ) : null}
    </div>
  );
}
