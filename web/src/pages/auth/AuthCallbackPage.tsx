import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ApiError, isGlobalOnboardingComplete } from '@porukam/core';
import { ErrorState, Skeleton } from '@porukam/ui';
import { useAuthStore } from '../../features/auth/authStore';
import { useGoogleCallback } from '../../features/auth/useAuth';
import { useGlobalConsents } from '../../features/onboarding/api';
import { takePendingInvite } from '../../features/onboarding/inviteContext';
import { useForceLocale } from '../../features/onboarding/useForceLocale';
import styles from './AuthScreen.module.css';

type Phase = 'loading' | 'denied' | 'error';

/**
 * Приём Google OAuth (GLOBAL У1, DEV-auth-onboarding §1): обмен кода на
 * сессию через бэк, затем — гард по онбордингу. Новый пользователь →
 * `/onboarding/consents`; существующий → в приложение (или в контекст
 * приглашения, если он был сохранён на Welcome).
 */
export function AuthCallbackPage(): JSX.Element {
  useForceLocale('en');
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const googleCallback = useGoogleCallback();
  const [phase, setPhase] = useState<Phase>('loading');
  const ranRef = useRef(false);

  const error = searchParams.get('error');
  const code = searchParams.get('code');
  const state = searchParams.get('state');

  // Нельзя переспросить готовый consents-запрос до успешного логина — читаем
  // его лениво прямо из ApiClient внутри onSuccess, не через хук с enabled.
  const consentsQuery = useGlobalConsents(googleCallback.isSuccess);

  useEffect(() => {
    if (ranRef.current) return;
    ranRef.current = true;

    // Повторный заход на callback-URL: мобильный браузер восстанавливает/
    // перезагружает вкладку с УЖЕ ИСПОЛЬЗОВАННЫМ code → бэк отвечает 422
    // state_invalid (прод-логи 2026-08-24 10:37:08, «выбрасывает» посреди
    // онбординга). Если сессия уже есть — человек вошёл, обменивать нечего:
    // молча идём в приложение (гард онбординга сам доведёт до нужного шага).
    if (useAuthStore.getState().isAuthenticated) {
      navigate('/', { replace: true });
      return;
    }

    if (error) {
      setPhase('denied');
      return;
    }
    if (!code || !state) {
      setPhase('error');
      return;
    }
    googleCallback.mutate(
      { code, state },
      {
        onError: () => {
          // Обмен упал, но сессия к этому моменту есть (гонка двух заходов
          // на callback) — тоже не ошибка входа, идём в приложение.
          if (useAuthStore.getState().isAuthenticated) {
            navigate('/', { replace: true });
            return;
          }
          setPhase('error');
        },
      },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!googleCallback.isSuccess || !googleCallback.data) return;
    if (consentsQuery.isPending) return;
    const me = googleCallback.data;
    if (isGlobalOnboardingComplete(me, consentsQuery.data)) {
      // Существующий пользователь — забираем контекст приглашения (если был) прямо
      // здесь. Новый пользователь (else-ветка) НЕ трогает его — заберёт BackupStepPage
      // в конце онбординга (§1: «по приглашению → редирект на присланный договор»
      // случается ПОСЛЕ прохождения шагов, а не сразу после логина).
      const pendingInvite = takePendingInvite();
      navigate(pendingInvite ? `/contracts/${pendingInvite.contractId}` : '/', { replace: true });
    } else {
      navigate('/onboarding/consents', { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [googleCallback.isSuccess, googleCallback.data, consentsQuery.isPending, consentsQuery.data]);

  if (phase === 'denied') {
    return (
      <div className={styles.screen}>
        <main className={styles.panel}>
          <div className={styles.card}>
            <ErrorState title={t('auth.callbackErrorDenied')} retryLabel={t('auth.callbackRetry')} onRetry={() => navigate('/welcome')} />
          </div>
        </main>
      </div>
    );
  }

  if (phase === 'error' || googleCallback.isError) {
    const code = googleCallback.error instanceof ApiError ? googleCallback.error.code : undefined;
    return (
      <div className={styles.screen}>
        <main className={styles.panel}>
          <div className={styles.card}>
            <ErrorState title={t('auth.callbackErrorTitle')} code={code} retryLabel={t('auth.callbackRetry')} onRetry={() => navigate('/welcome')} />
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className={styles.screen}>
      <main className={styles.panel}>
        <div className={styles.card} aria-busy="true">
          <Skeleton width="60%" height={24} />
          <Skeleton width="100%" height={16} />
          <p>{t('auth.callbackLoading')}</p>
        </div>
      </main>
    </div>
  );
}

