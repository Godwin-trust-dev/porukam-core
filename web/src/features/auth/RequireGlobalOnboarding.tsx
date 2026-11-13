import type { ReactNode } from 'react';
import { Navigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ApiError, isGlobalOnboardingComplete } from '@porukam/core';
import { ErrorState } from '@porukam/ui';
import { useAuthStore } from './authStore';
import { useCurrentUser } from './useAuth';
import { useGlobalConsents } from '../onboarding/api';
import { apiErrorText } from '../../shared/apiErrorText';

/**
 * Гард для GLOBAL У1 (DEV-auth-onboarding §1): новый пользователь, вошедший
 * через Google, без пройденного онбординга — на `/onboarding/consents`.
 * Сигнал — `authStore.loginMethod === 'google'`, НЕ `me.identity?.provider`:
 * то же поле уже занято у RU-мока как витрина `IdentityCard` (DEV-09,
 * `web/src/mocks/data.ts`) и не отражает реальный способ входа — проверено
 * на живую (см. отчёт по задаче, регрессия full e2e). Ставится ВНУТРИ
 * `RequireAuth` (после подтверждённой сессии) вокруг оболочки приложения.
 *
 * Редирект — ТОЛЬКО по успешно загруженным данным (прод-инцидент
 * 2026-08-24, вход с телефона): при ошибке `/users/me` или согласий
 * `data === undefined` трактовался как «онбординг не пройден» → выброс
 * давно онбордившегося человека на `/onboarding/consents`, где «Повторить»
 * перезапрашивал только согласия и ничего не менял. Теперь ошибка любого
 * из двух запросов — честный ErrorState на месте с ретраем ОБОИХ.
 */
export function RequireGlobalOnboarding({ children }: { children: ReactNode }): JSX.Element {
  const { t } = useTranslation();
  const isGoogleSession = useAuthStore((s) => s.loginMethod) === 'google';
  const me = useCurrentUser();
  const consents = useGlobalConsents(isGoogleSession);

  if (!isGoogleSession) return <>{children}</>;
  if (me.isPending || consents.isPending) return <></>;

  if (me.isError || consents.isError) {
    const err = me.error ?? consents.error;
    return (
      <ErrorState
        title={t('common.unexpectedErrorTitle')}
        text={apiErrorText(err)}
        code={err instanceof ApiError ? err.code : undefined}
        retryLabel={t('common.retry')}
        onRetry={() => {
          if (me.isError) void me.refetch();
          if (consents.isError) void consents.refetch();
        }}
      />
    );
  }

  if (!isGlobalOnboardingComplete(me.data, consents.data)) {
    return <Navigate to="/onboarding/consents" replace />;
  }
  return <>{children}</>;
}
