import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { LegalDocSlug } from '@porukam/core';
import { Button, ConsentAgree, ErrorState, Skeleton, VisibilityChoice, type ProfileVisibilityValue } from '@porukam/ui';
import { LegalDocumentDialog } from '../../features/legal/LegalDocumentDialog';
import { useGlobalConsents, useSubmitGlobalConsents } from '../../features/onboarding/api';
import styles from './OnboardingLayout.module.css';

/**
 * Шаг «Данные и приватность» (ConsentsStep, DEV-auth-onboarding §5) — канон
 * `legal-global/03` (ЧЕРНОВИК до Ю-23, см. `packages/i18n/src/en.ts`).
 * Ничего не предзаполнено (silence ≠ согласие); «Продолжить» активна только
 * при обоих обязательных согласиях + выбранной видимости.
 *
 * Язык интерфейса — БЕЗ принудительного `useForceLocale('en')` (был снят,
 * docs/tasks/Задача_fix_web-consents-crash.md §2): экран уважает выбранный
 * пользователем язык (`useLocaleResolution`, смонтирован у корня), как
 * остальной UI после `fix/web-locales-switcher` — RU-тексты есть
 * (`packages/i18n/src/locales/ru/onboarding.json`).
 */
export function ConsentsPage(): JSX.Element {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { data: consents, isPending, isError, refetch } = useGlobalConsents();
  const submit = useSubmitGlobalConsents();

  const [dataAgree, setDataAgree] = useState(false);
  const [reputationAgree, setReputationAgree] = useState(false);
  const [visibility, setVisibility] = useState<ProfileVisibilityValue | null>(null);
  const [dataFullTextOpen, setDataFullTextOpen] = useState(false);
  const [openLegalDoc, setOpenLegalDoc] = useState<LegalDocSlug | null>(null);

  // Возобновление шага (пользователь ушёл и вернулся) — подставляем уже
  // сохранённое, а не молчаливый дефолт (§5: предзаполнение — только своим же выбором).
  useEffect(() => {
    if (!consents) return;
    setDataAgree(consents.pd_processing === true);
    setReputationAgree(consents.reputation_history_basis === true);
    setVisibility(consents.profile_public === null ? null : consents.profile_public ? 'public' : 'link_and_deals');
  }, [consents]);

  const canContinue = dataAgree && reputationAgree && visibility !== null;

  async function onContinue(): Promise<void> {
    if (!canContinue || !visibility) return;
    await submit.mutateAsync({
      pd_processing: true,
      profile_public: visibility === 'public',
      // Находимость по телефону в GLOBAL не показывается (нет телефона в профиле, §5) — всегда false.
      phone_discoverability: false,
      reputation_history_basis: true,
    });
    navigate('/onboarding/profile');
  }

  if (isPending) {
    return (
      <div className={styles.screen} data-density="cozy">
        <div className={styles.wrap} aria-busy="true">
          <Skeleton width="70%" height={32} />
          <Skeleton width="100%" height={140} radius="var(--pr-r-lg)" />
          <Skeleton width="100%" height={120} radius="var(--pr-r-lg)" />
          <Skeleton width="100%" height={140} radius="var(--pr-r-lg)" />
        </div>
      </div>
    );
  }

  if (isError) {
    return (
      <div className={styles.screen} data-density="cozy">
        <div className={styles.wrap}>
          <ErrorState
            title={t('common.unexpectedErrorTitle')}
            retryLabel={t('common.retry')}
            onRetry={() => void refetch()}
          />
        </div>
      </div>
    );
  }

  return (
    <div className={styles.screen} data-density="cozy">
      <div className={styles.wrap}>
        <h1 className={styles.title}>{t('onboarding.consentsTitle')}</h1>

        <ConsentAgree
          title={t('onboarding.dataTitle')}
          body={t('onboarding.dataBody')}
          readMoreLabel={t('onboarding.dataReadMore')}
          onReadMore={() => setDataFullTextOpen((open) => !open)}
          readMoreExpanded={dataFullTextOpen}
          expandedText={t('onboarding.dataFullText')}
          agreeLabel={t('onboarding.dataAgree')}
          checked={dataAgree}
          onChange={setDataAgree}
          required
        />

        {/* Сами документы — на текущем языке, в шторке (feat/l10n-launch-surfaces
            §B): согласие даётся здесь, значит и прочитать Условия/Политику надо
            уметь здесь, не уходя с шага и не теряя уже проставленные галочки. */}
        <div className={styles.legalLinks}>
          <button type="button" className={styles.legalLink} onClick={() => setOpenLegalDoc('terms')}>
            {t('auth.tosLinkLabel')}
          </button>
          <button type="button" className={styles.legalLink} onClick={() => setOpenLegalDoc('privacy')}>
            {t('auth.privacyLinkLabel')}
          </button>
        </div>

        <VisibilityChoice
          title={t('onboarding.visibilityTitle')}
          value={visibility}
          onChange={setVisibility}
          publicLabel={t('onboarding.visibilityPublic')}
          publicBadge={t('onboarding.visibilityPublicBadge')}
          linkOnlyLabel={t('onboarding.visibilityLinkOnly')}
          hint={t('onboarding.visibilityHint')}
          ariaLabel={t('onboarding.visibilityTitle')}
        />

        <ConsentAgree
          title={t('onboarding.reputationTitle')}
          body={t('onboarding.reputationBody')}
          agreeLabel={t('onboarding.reputationAgree')}
          checked={reputationAgree}
          onChange={setReputationAgree}
          required
        />

        <Button variant="primary" block onClick={() => void onContinue()} loading={submit.isPending} disabled={!canContinue} aria-disabled={!canContinue}>
          {t('onboarding.continue')}
        </Button>
      </div>

      <LegalDocumentDialog doc={openLegalDoc} onClose={() => setOpenLegalDoc(null)} />
    </div>
  );
}
