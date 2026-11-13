import { Navigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ApiError } from '@porukam/core';
import { ErrorState, Skeleton } from '@porukam/ui';
import { useCurrentUser } from '../features/auth/useAuth';
import { useActorStore } from '../features/actor/actorStore';
import { apiErrorText } from '../shared/apiErrorText';

/**
 * `/reputation` — МОЯ репутационная карточка (отсмотр 2026-08-22): редирект
 * на существующую страницу карточки (`/reputation/profiles/{id}`,
 * ReputationCardPage) с id активного актёра — владелец всегда видит полную
 * карточку (ADR-059/076). Отдельного экрана нет намеренно: карточка одна и
 * та же для «своей» и «чужой» репутации — один источник правды.
 */
export function MyReputationPage(): JSX.Element {
  const { t } = useTranslation();
  const activeProfileId = useActorStore((s) => s.activeProfileId);
  const { data: me, isPending, error, refetch } = useCurrentUser();

  const profileId =
    activeProfileId ??
    me?.profiles.find((p) => p.kind === 'person')?.id ??
    me?.profiles[0]?.id ??
    null;

  if (profileId) return <Navigate to={`/reputation/profiles/${profileId}`} replace />;
  if (isPending) return <Skeleton height={240} />;
  return (
    <ErrorState
      title={t('common.unexpectedErrorTitle')}
      text={apiErrorText(error)}
      code={error instanceof ApiError ? error.code : undefined}
      retryLabel={t('common.retry')}
      onRetry={() => void refetch()}
    />
  );
}
