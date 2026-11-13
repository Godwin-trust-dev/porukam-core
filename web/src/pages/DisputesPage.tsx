import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { ApiError, type Dispute, type DisputeKind, type DisputeStatus } from '@porukam/core';
import { EmptyState, ErrorState, ListRow, ScreenTabs, Skeleton, StatusWord, Surface, type BadgeTone } from '@porukam/ui';
import { useDisputes, useWarrantyClaims } from '../features/disputes/api';
import { CounterpartyLink } from '../features/counterparty/CounterpartyLink';
import { useFormatters } from '../shared/formatters';
import styles from './DisputesPage.module.css';
import { apiErrorText } from '../shared/apiErrorText';

const STATUS_TONE: Record<DisputeStatus, BadgeTone> = {
  open: 'red',
  awaiting_fix: 'amber',
  awaiting_discount: 'amber',
  resolved: 'green',
};

const STATUS_KEY: Record<DisputeStatus, string> = {
  open: 'dispute.statusOpen',
  awaiting_fix: 'dispute.statusAwaitingFix',
  awaiting_discount: 'dispute.statusAwaitingDiscount',
  resolved: 'dispute.statusResolved',
};

type TabKey = 'all' | 'milestone' | 'warranty';

/**
 * `/disputes` — все разногласия договоров, где я сторона (tech-spec.md §8.8).
 *
 * С этапа 7 (ADR-131 §9) вторая сторона приходит В САМОМ ответе
 * (`counterparty: {profile_id, display_name, role}`) — раскопки в кэше
 * `GET /contracts` убраны: раздел молча терял контрагента, пока список
 * договоров не загружен. Заголовка договора сериализатор по-прежнему не
 * отдаёт, поэтому строка называет разногласие по его виду, а договор
 * открывается переходом в карточку.
 *
 * Вкладка «Гарантия» показывает ЗАЯВКИ (`GET /warranty-claims`), а не споры:
 * претензия — самостоятельный юрфакт со своей метрикой (ADR-030), диалог по
 * ней идёт в связанном разногласии (`dispute_id`).
 *
 * Раскладка — строка доски A (ADR-152, замечание владельца 03.09 «споры и
 * репутацию, объединения тоже сразу проверь на дизайн»): карточки с рамкой
 * нет, строки лежат на одной поверхности, статус — словом-цветом в конце
 * второй строки, потолок 30 дней — третьей.
 */
export function DisputesPage(): JSX.Element {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { formatDate } = useFormatters();
  const [tab, setTab] = useState<TabKey>('all');

  const kind: DisputeKind | undefined = tab === 'milestone' ? 'milestone' : undefined;
  const disputesQ = useDisputes({ kind });
  const claimsQ = useWarrantyClaims();

  const tabs = (
    /* DEV-20_2 §3: три коротких вкладки влезают — допустимо, но полоса не
       скроллится вбок ни на какой ширине (`ScreenTabs`, `allowExtra`). */
    <ScreenTabs
      active={tab}
      onChange={(key) => setTab(key as TabKey)}
      ariaLabel={t('dispute.listTitle')}
      allowExtra
      items={[
        { key: 'all', label: t('dispute.tabAll') },
        { key: 'milestone', label: t('dispute.tabMilestone') },
        { key: 'warranty', label: t('dispute.tabWarranty'), count: claimsQ.data?.length },
      ]}
    />
  );

  function rowTitle(dispute: Dispute): string {
    return dispute.kind === 'warranty' ? t('dispute.kindWarranty') : t('dispute.kindMilestone');
  }

  if (tab === 'warranty') {
    return (
      <div className={styles.page}>
        {tabs}
        <WarrantyClaims />
      </div>
    );
  }

  if (disputesQ.isPending) {
    return (
      <div className={styles.page} aria-busy="true">
        {tabs}
        <Skeleton height={54} radius="var(--pr-d-r-surface)" />
        <Skeleton height={54} radius="var(--pr-d-r-surface)" />
      </div>
    );
  }
  if (disputesQ.error) {
    return (
      <div className={styles.page}>
        {tabs}
        <ErrorState
          title={t('common.unexpectedErrorTitle')}
          text={apiErrorText(disputesQ.error)}
          code={disputesQ.error instanceof ApiError ? disputesQ.error.code : undefined}
          retryLabel={t('common.retry')}
          onRetry={() => void disputesQ.refetch()}
        />
      </div>
    );
  }

  const data = disputesQ.data ?? [];
  if (data.length === 0) {
    return (
      <div className={styles.page}>
        {tabs}
        <EmptyState icon="dispute" title={t('dispute.emptyTitle')} text={t('dispute.emptyText')} />
      </div>
    );
  }

  return (
    <div className={styles.page}>
      {tabs}
      <Surface bleed data-testid="disputes-list">
        {data.map((dispute) => (
          <ListRow
            key={dispute.id}
            avatarName={dispute.counterparty?.display_name ?? rowTitle(dispute)}
            /* ADR-173: фото контрагента спора; null — инициалы. */
            avatarSrc={dispute.counterparty?.avatar_url ?? undefined}
            title={rowTitle(dispute)}
            meta={
              <>
                {dispute.counterparty ? (
                  <>
                    <CounterpartyLink
                      profileId={dispute.counterparty.profile_id}
                      name={dispute.counterparty.display_name}
                      showHandle={false}
                      plain
                    />
                    {' · '}
                  </>
                ) : null}
                {t('dispute.openedAt', { date: formatDate(dispute.opened_at, { legal: true }) })}
              </>
            }
            status={<StatusWord label={t(STATUS_KEY[dispute.status])} tone={STATUS_TONE[dispute.status]} />}
            /* Потолок 30 дней (ADR-020) — самое важное число строки: после
               него разбирательство закрывается само. Третьей строкой, а не
               под статусом: на 360px эти два факта наезжали друг на друга. */
            extra={
              [
                dispute.status !== 'resolved' && dispute.days_to_cap !== null
                  ? t('dispute.daysToCap', { count: dispute.days_to_cap })
                  : null,
                dispute.resolved_at
                  ? t('dispute.resolvedAt', { date: formatDate(dispute.resolved_at, { legal: true }) })
                  : null,
              ]
                .filter(Boolean)
                .join(' · ') || undefined
            }
            ariaLabel={rowTitle(dispute)}
            onOpen={() => navigate(`/disputes/${dispute.id}`)}
          />
        ))}
      </Surface>
    </div>
  );
}

/** Вкладка «Гарантия»: заявки текущего профиля с переходом в связанное
 * разногласие (`dispute_id`) — сам диалог живёт там. */
function WarrantyClaims(): JSX.Element {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { formatDate } = useFormatters();
  const { data, isPending, error, refetch } = useWarrantyClaims();

  if (isPending) return <Skeleton height={54} radius="var(--pr-d-r-surface)" />;
  if (error) {
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
  if (!data || data.length === 0) {
    return <EmptyState icon="dispute" title={t('dispute.warrantyEmptyTitle')} text={t('dispute.warrantyEmptyText')} />;
  }

  return (
    <Surface bleed data-testid="warranty-claims-list">
      {data.map((claim) => (
        <ListRow
          key={claim.id}
          avatarName={claim.description}
          title={claim.description}
          meta={t('dispute.warrantySubmittedAt', { date: formatDate(claim.submitted_at, { legal: true }) })}
          status={
            <StatusWord
              label={t(
                claim.status === 'resolved'
                  ? 'dispute.warrantyStatusResolved'
                  : claim.status === 'awaiting_confirmation'
                    ? 'dispute.warrantyStatusFixSubmitted'
                    : 'dispute.warrantyStatusSubmitted',
              )}
              tone={claim.status === 'resolved' ? 'green' : claim.status === 'awaiting_confirmation' ? 'teal' : 'amber'}
            />
          }
          ariaLabel={claim.description}
          onOpen={() => navigate(claim.dispute_id ? `/disputes/${claim.dispute_id}` : `/contracts/${claim.contract_id}`)}
        />
      ))}
    </Surface>
  );
}
