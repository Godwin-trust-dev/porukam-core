import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { Button, Icon, ScreenHeader } from '@porukam/ui';
import { SocialLinks } from '../../features/social-links/SocialLinks';
import { HelpAccordion } from './HelpAccordion';
import styles from './HelpPage.module.css';

/**
 * FAQ с ответами (отсмотр 2026-08-22). Тексты — неймспейс `help`.
 *
 * Замечание владельца 03.09: «текст компактно, мельче, без рамок и лишних
 * отступов». Карточки вокруг списка нет — вопросы стоят строками-заголовками
 * `Disclosure` на одной поверхности, ответ раскрывается по тапу (ADR-152).
 */
export function FaqPage(): JSX.Element {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const raw = t('help.faqItems', { returnObjects: true }) as Array<{ q: string; a: string }>;
  const items = Array.isArray(raw) ? raw.map((x) => ({ title: x.q, text: x.a })) : [];
  return (
    <div className={styles.page}>
      <ScreenHeader
        title={t('help.faqTitle')}
        back={
          <button type="button" className={styles.back} onClick={() => navigate('/me')} aria-label={t('help.backToProfile')}>
            <Icon name="back" size={20} directional />
          </button>
        }
      />
      <HelpAccordion items={items} testId="help-faq" />
      <div className={styles.links}>
        <Button variant="secondary" size="sm" onClick={() => navigate('/help/about')}>
          {t('help.aboutTitle')}
        </Button>
      </div>
      <SocialLinks title={t('help.socialTitle')} />
    </div>
  );
}
