import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ApiError } from '@porukam/core';
import { BackupOption, Button, OnboardingDone, Skeleton } from '@porukam/ui';
import { useConnectDriveBackup, useDriveBackup } from '../../features/onboarding/api';
import { takePendingInvite } from '../../features/onboarding/inviteContext';
import { useForceLocale } from '../../features/onboarding/useForceLocale';
import styles from './OnboardingLayout.module.css';

type Step = 'form' | 'done';

/**
 * Шаг «Бэкап» (BackupStep, DEV-auth-onboarding §6) — опционален, «Позже» не
 * блокирует. Финал (§7) — короткая искра, затем редирект: по приглашению —
 * сразу на присланный договор, иначе — в пустой дашборд (честная свежесть).
 */
export function BackupStepPage(): JSX.Element {
  useForceLocale('en');
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { data: backup, isPending } = useDriveBackup();
  const connect = useConnectDriveBackup();
  const [step, setStep] = useState<Step>('form');

  function finish(): void {
    setStep('done');
  }

  useEffect(() => {
    if (step !== 'done') return;
    const id = window.setTimeout(() => {
      const pendingInvite = takePendingInvite();
      navigate(pendingInvite ? `/contracts/${pendingInvite.contractId}` : '/', { replace: true });
    }, 900);
    return () => window.clearTimeout(id);
  }, [step, navigate]);

  async function onConnect(): Promise<void> {
    try {
      await connect.mutateAsync();
    } catch {
      // Ошибка подключения показана через connect.isError ниже — «Позже» остаётся доступно.
    }
  }

  if (step === 'done') {
    return (
      <div className={styles.screen} data-density="cozy">
        <div className={styles.wrap}>
          <OnboardingDone title={t('onboarding.doneTitle')} subtitle={t('onboarding.doneSubtitle')} />
        </div>
      </div>
    );
  }

  if (isPending || !backup) {
    return (
      <div className={styles.screen} data-density="cozy">
        <div className={styles.wrap} aria-busy="true">
          <Skeleton width="70%" height={32} />
          <Skeleton width="100%" height={140} radius="var(--pr-r-lg)" />
        </div>
      </div>
    );
  }

  return (
    <div className={styles.screen} data-density="cozy">
      <div className={styles.wrap}>
        <h1 className={styles.title}>{t('onboarding.backupTitle')}</h1>
        <BackupOption
          title={t('onboarding.backupTitle')}
          text={t('onboarding.backupText')}
          connectLabel={t('onboarding.backupConnect')}
          skipLabel={t('onboarding.backupSkip')}
          connected={backup.connected}
          connectedLabel={t('onboarding.backupConnected')}
          loading={connect.isPending}
          error={connect.isError && connect.error instanceof ApiError ? t('onboarding.backupError') : undefined}
          onConnect={() => void onConnect()}
          onSkip={finish}
        />
        {backup.connected ? (
          <Button variant="primary" block onClick={finish}>
            {t('onboarding.continue')}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
