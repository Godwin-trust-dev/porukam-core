import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { ApiError, formatMoney, formatShortDate } from '@porukam/core';
import { Badge, Card, EmptyState, ErrorState, Skeleton, type BadgeTone } from '@porukam/ui';
import { useStagesSection } from '../features/sections/api';
import { SectionRow } from '../features/sections/SectionRow';
import { CounterpartyLink } from '../features/counterparty/CounterpartyLink';
import styles from './StagesPage.module.css';
import { apiErrorText } from '../shared/apiErrorText';

/**
 * `/stages` — сводка этапов по всем договорам в исполнении (отсмотр
 * 2026-08-22, ADR-109): `GET /v1/dashboard/stages`, листья с ближайшим
 * дедлайном первыми. Строка ведёт в карточку договора — сдача/приёмка
 * живут там (StagePage контура одного договора).
 */

const STATUS_TONE: Record<string, BadgeTone> = {
  pending: 'neutral',
  in_progress: 'teal',
  suspended: 'amber',
  under_acceptance: 'amber',
  accepted: 'green',
  disputed: 'red',
  paid: 'green',
};

const STATUS_KEY: Record<string, string> = {
  pending: 'dashboard.stageStatusPending',
  in_progress: 'dashboard.stageStatusInProgress',
  suspended: 'dashboard.stageStatusSuspended',
  under_acceptance: 'dashboard.stageStatusUnderAcceptance',
  accepted: 'dashboard.stageStatusAccepted',
  disputed: 'dashboard.stageStatusDisputed',
  paid: 'dashboard.stageStatusPaid',
};

export function StagesPage(): JSX.Element {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const { data, isPending, error, refetch } = useStagesSection();

  if (isPending) {
    return (
      <div className={styles.list} aria-busy="true">
        <Skeleton height={72} />
        <Skeleton height={72} />
        <Skeleton height={72} />
      </div>
    );
  }
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
  if (!data || data.items.length === 0) {
    return <EmptyState icon="stages" title={t('dashboard.stagesEmptyTitle')} text={t('dashboard.stagesEmptyText')} />;
  }

  return (
    <Card>
      <ul className={styles.list} data-testid="stages-list">
        {data.items.map((item) => (
          <li key={item.id}>
            <SectionRow
              className={styles.row}
              label={item.title}
              onOpen={() => navigate(`/contracts/${item.contract_id}`)}
            >
              <span className={styles.main}>
                <span className={styles.title}>{item.title}</span>
                <span className={styles.meta}>
                  <span>{item.contract_title}</span>
                  <span aria-hidden="true">·</span>
                  {/* Бэклог 2026-08-21: контрагент кликабелен и в разделах. */}
                  <CounterpartyLink
                    profileId={item.counterparty.profile_id}
                    name={item.counterparty.display_name ?? t('dashboard.sectionCounterpartyFallback')}
                    showHandle={false}
                  />
                </span>
              </span>
              <span className={styles.side}>
                <Badge tone={STATUS_TONE[item.status] ?? 'neutral'}>
                  {t(STATUS_KEY[item.status] ?? 'dashboard.stageStatusPending')}
                </Badge>
                {item.amount && item.amount_currency ? (
                  <span className={styles.amount}>
                    {formatMoney({ amount: item.amount, currency: item.amount_currency }, i18n.language)}
                  </span>
                ) : null}
                {item.deadline ? (
                  <span className={styles.deadline}>
                    {t('dashboard.stageDeadline', { date: formatShortDate(item.deadline, i18n.language) })}
                  </span>
                ) : null}
              </span>
            </SectionRow>
          </li>
        ))}
      </ul>
    </Card>
  );
}
