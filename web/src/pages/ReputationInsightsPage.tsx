import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ApiError, type ReputationInsightMetric } from '@porukam/core';
import {
  Button,
  EmptyState,
  ErrorState,
  Icon,
  SectionLabel,
  Skeleton,
  Surface,
  ZoneBar,
  zoneOf,
} from '@porukam/ui';
import { useCurrentUser } from '../features/auth/useAuth';
import { useActorStore } from '../features/actor/actorStore';
import { useReputationInsights } from '../features/reputation/api';
import { useSpheres } from '../features/contractNew/api';
import { useFormatters } from '../shared/formatters';
import { apiErrorText } from '../shared/apiErrorText';
import styles from './ReputationInsightsPage.module.css';

/**
 * `/me/reputation` — приватный разбор СВОЕЙ репутации (ADR-163 §8).
 *
 * Экран владельца, а не вторая версия карточки: здесь видно, из чего
 * сложилась каждая цифра (какие этапы вернули и почему, что сдано или
 * оплачено с опозданием, где были споры), сколько осталось до зелёной
 * зоны, и что платформа СЧИТАЕТ, но другим не показывает — объём по
 * валютам и долю защищённых платежей.
 *
 * Бэк отдаёт эти данные только владельцу (403 всем остальным), поэтому
 * «своей» проверки прав здесь нет: одна проверка, и та на сервере.
 */
export function ReputationInsightsPage(): JSX.Element {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const activeProfileId = useActorStore((s) => s.activeProfileId);
  const { data: me } = useCurrentUser();
  const profileId =
    activeProfileId ??
    me?.profiles.find((p) => p.kind === 'person')?.id ??
    me?.profiles[0]?.id ??
    null;
  const { data, isPending, error, refetch } = useReputationInsights(profileId);

  if (isPending) return <Skeleton height={280} />;
  if (error) {
    return (
      <div className={styles.page}>
        <ErrorState
          title={t('reputation.errorTitle')}
          text={apiErrorText(error)}
          code={error instanceof ApiError ? error.code : undefined}
          retryLabel={t('common.retry')}
          onRetry={() => void refetch()}
        />
      </div>
    );
  }
  if (!data) return <></>;

  return (
    <div className={styles.page}>
      <div className={styles.layout}>
        <h1 className={styles.title}>{t('reputation.insightsTitle')}</h1>

        {/* «Так вас видит гость и контрагент» — первым блоком: разбор имеет
            смысл только рядом со ссылкой на то, что видят другие. */}
        <Surface bleed padded className={styles.guestRow} data-testid="insights-guest">
          <p className={styles.guestText}>{t('reputation.insightsOpenCard')}</p>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => navigate(`/reputation/profiles/${profileId}`)}
          >
            {t('reputation.insightsOpenCardAction')}
          </Button>
        </Surface>

        <div className={styles.section}>
          <SectionLabel level={3}>{t('reputation.insightsRecentTitle')}</SectionLabel>
          <Surface bleed data-testid="insights-recent">
            <p className={styles.row}>
              {t('reputation.insightsRecentDeals', { n: data.recent.deals })}
            </p>
            <p className={styles.row}>
              {t('reputation.insightsRecentCounterparties', { n: data.recent.counterparties })}
            </p>
            <p className={styles.row}>
              {t('reputation.insightsRecentRejections', { n: data.recent.rejections })}
            </p>
          </Surface>
        </div>

        {data.metrics.length === 0 ? (
          <EmptyState
            icon="reputation"
            title={t('reputation.insightsEmptyTitle')}
            text={t('reputation.insightsEmptyText')}
          />
        ) : (
          <div className={styles.section}>
            <SectionLabel level={3}>{t('reputation.insightsMetricsTitle')}</SectionLabel>
            <Surface bleed data-testid="insights-metrics">
              {data.metrics.map((metric) => (
                <MetricRow key={`${metric.code}:${metric.role}`} metric={metric} />
              ))}
            </Surface>
          </div>
        )}

        <div className={styles.section}>
          <SectionLabel level={3}>{t('reputation.insightsHiddenTitle')}</SectionLabel>
          <Surface bleed padded data-testid="insights-hidden">
            <p className={styles.hiddenText}>{t('reputation.insightsHiddenText')}</p>
            <p className={styles.row}>
              {t('reputation.insightsVolume')}:{' '}
              {data.hidden.volume.length === 0
                ? t('reputation.noAxisData')
                : data.hidden.volume.map((v) => `${v.amount} ${v.currency}`).join(' · ')}
            </p>
            <p className={styles.row}>
              {t('reputation.insightsProtected', {
                done: data.hidden.protected_payments.done,
                total: data.hidden.protected_payments.total,
              })}
            </p>
          </Surface>
        </div>
      </div>
    </div>
  );
}

const METRIC_LABEL_KEY: Record<string, string> = {
  'on_time_delivery:contractor': 'reputation.insightsMetricOnTimeDelivery',
  'on_time_payment:customer': 'reputation.insightsMetricOnTimePayment',
  'prompt_acceptance:customer': 'reputation.insightsMetricPromptAcceptance',
  'first_time:contractor': 'reputation.insightsMetricFirstTimeContractor',
  'first_time:customer': 'reputation.insightsMetricFirstTimeCustomer',
  'disputes_free:': 'reputation.insightsMetricDisputesFree',
};

const METRIC_STAT_KEY: Record<string, string> = {
  on_time_delivery: 'reputation.statOnTimeDelivery',
  on_time_payment: 'reputation.statOnTimePayment',
  prompt_acceptance: 'reputation.statPromptAcceptance',
  first_time: 'reputation.statFirstTime',
  disputes_free: 'reputation.statDisputesFree',
};

/** Строка метрики: полоса зоны, подсказка «до зелёной осталось N» и
 * раскрытие в конкретные сделки/этапы. Раскрытие закрыто по умолчанию —
 * на 360 развёрнутые списки шести метрик превратили бы экран в простыню. */
function MetricRow({ metric }: { metric: ReputationInsightMetric }): JSX.Element {
  const { t } = useTranslation();
  const { formatShortDate } = useFormatters();
  const { data: spheres } = useSpheres('');
  const [open, setOpen] = useState(false);
  const sphereName = (code: string): string =>
    [...(spheres?.results ?? []), ...(spheres?.popular ?? [])].find((s) => s.code === code)?.name ??
    code;

  const ratio = { done: metric.done, total: metric.total };
  const zone = zoneOf(ratio);
  const label = t(
    METRIC_LABEL_KEY[`${metric.code}:${metric.role}`] ?? 'reputation.insightsMetricsTitle',
  );
  const statLabel = t(METRIC_STAT_KEY[metric.code] ?? 'reputation.statFirstTime', {
    done: metric.done,
    total: metric.total,
  });
  const zoneName =
    zone === 'red'
      ? t('reputation.insightsZoneRed')
      : zone === 'amber'
        ? t('reputation.insightsZoneAmber')
        : t('reputation.insightsZoneGreen');

  return (
    <div className={styles.metric}>
      <p className={styles.metricName}>{label}</p>
      <ZoneBar ratio={ratio} label={statLabel} ariaLabel={`${label}: ${statLabel}`} />
      <p className={styles.hint}>
        {zoneName}
        {metric.to_green === null
          ? ''
          : ` · ${t('reputation.insightsToGreen', { n: metric.to_green })}`}
      </p>
      {metric.items.length > 0 ? (
        <>
          <button
            type="button"
            className={styles.expand}
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
            data-testid={`insights-expand-${metric.code}-${metric.role || 'any'}`}
          >
            {open ? t('reputation.insightsCollapse') : t('reputation.insightsExpand')}
            <Icon
              name="back"
              size={16}
              className={open ? styles.chevronOpen : styles.chevron}
              directional
            />
          </button>
          {open ? (
            <ul className={styles.items}>
              {metric.items.map((item) => (
                <li
                  key={`${item.contract_id}:${item.milestone_id ?? 'deal'}`}
                  className={styles.item}
                >
                  <span className={styles.itemTitle}>
                    {item.title || sphereName(item.sphere_code)}
                  </span>
                  <span className={styles.itemMeta}>
                    {item.happened_at ? formatShortDate(item.happened_at) : null}
                    {item.detail === 'auto_accepted'
                      ? ` · ${t('reputation.insightsItemAutoAccepted')}`
                      : item.detail
                        ? ` · ${item.detail}`
                        : null}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
