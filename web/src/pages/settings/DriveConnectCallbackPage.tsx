import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ApiError } from '@porukam/core';
import { EmptyState, ErrorState, Skeleton } from '@porukam/ui';
import { useDriveConnectCallback } from '../../features/profile/api';
import styles from './DriveConnectCallbackPage.module.css';

type Phase = 'loading' | 'success' | 'denied' | 'error';

// Задержка перед редиректом на success (docs/tasks/Задача_feat_web-oauth-callbacks.md
// §2.1: «по успеху показать "Drive подключён"», не молча уводить сразу) — тот же
// приём/тайминг, что финал онбординга (BackupStepPage.tsx). БЕЗ <Spark> — Drive-
// коннект не событие доверия (web/CLAUDE.md правило 7: вход, обе подписи, больше нигде).
const SUCCESS_REDIRECT_DELAY_MS = 900;

/**
 * Приём callback реального Drive-OAuth (ADR-084, `EVIDENCE_DRIVE_PROVIDER=real`,
 * `GOOGLE_DRIVE_CONNECT_REDIRECT_URI=.../settings/drive/callback`) — обмен
 * `code`/`state` на грант через боевой `POST /users/me/drive/connect/callback`
 * (`useDriveConnectCallback`, не мок — в mock-режиме тот же путь отыгрывает
 * MSW-хендлер `authGlobalHandlers.ts`, как и весь остальной API-слой Ф1-Ф5,
 * web/CLAUDE.md §3), тот же приём, что `AuthCallbackPage` для входа, но
 * ОТДЕЛЬНАЯ инкрементальная авторизация уже залогиненного пользователя.
 * Статус подключения после успеха читается отдельным экраном Settings — здесь
 * только сам приём, краткое подтверждение и редирект обратно.
 */
export function DriveConnectCallbackPage(): JSX.Element {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const callback = useDriveConnectCallback();
  const [phase, setPhase] = useState<Phase>('loading');
  const ranRef = useRef(false);

  const error = searchParams.get('error');
  const code = searchParams.get('code');
  const state = searchParams.get('state');

  useEffect(() => {
    if (ranRef.current) return;
    ranRef.current = true;

    if (error) {
      setPhase('denied');
      return;
    }
    if (!code || !state) {
      setPhase('error');
      return;
    }
    callback.mutate(
      { code, state },
      {
        onSuccess: () => setPhase('success'),
        onError: () => setPhase('error'),
      },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (phase !== 'success') return;
    const id = window.setTimeout(() => navigate('/me/settings', { replace: true }), SUCCESS_REDIRECT_DELAY_MS);
    return () => window.clearTimeout(id);
  }, [phase, navigate]);

  if (phase === 'success') {
    return (
      <div className={styles.screen}>
        <div className={styles.card}>
          <EmptyState icon="verified" title={t('profile.driveCallbackSuccess')} />
        </div>
      </div>
    );
  }

  if (phase === 'denied') {
    return (
      <div className={styles.screen}>
        <div className={styles.card}>
          <ErrorState
            title={t('profile.driveCallbackErrorDenied')}
            retryLabel={t('profile.driveCallbackRetry')}
            onRetry={() => navigate('/me/settings', { replace: true })}
          />
        </div>
      </div>
    );
  }

  if (phase === 'error' || callback.isError) {
    const errCode = callback.error instanceof ApiError ? callback.error.code : undefined;
    return (
      <div className={styles.screen}>
        <div className={styles.card}>
          <ErrorState
            title={t('profile.driveCallbackErrorTitle')}
            code={errCode}
            retryLabel={t('profile.driveCallbackRetry')}
            onRetry={() => navigate('/me/settings', { replace: true })}
          />
        </div>
      </div>
    );
  }

  return (
    <div className={styles.screen}>
      <div className={styles.card} aria-busy="true">
        <Skeleton width="60%" height={24} />
        <Skeleton width="100%" height={16} />
        <p>{t('profile.driveCallbackLoading')}</p>
      </div>
    </div>
  );
}
