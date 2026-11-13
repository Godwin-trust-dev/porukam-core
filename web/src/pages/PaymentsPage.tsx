import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import {
  ApiError,
  Money,
  formatShortDate,
  formatMoney,
  type PaymentSectionItem,
  type PaymentSectionState,
} from '@porukam/core';
import { EmptyState, ErrorState, ListRow, SectionLabel, Skeleton, Surface } from '@porukam/ui';
import { usePaymentsSection } from '../features/sections/api';
import { CounterpartyLink } from '../features/counterparty/CounterpartyLink';
import styles from './PaymentsPage.module.css';
import { apiErrorText } from '../shared/apiErrorText';

/**
 * `/payments` — деньги по этапам всех договоров (отсмотр 2026-08-22,
 * ADR-109): `GET /v1/dashboard/payments`. Платёжное состояние выводит бэк
 * (двусторонние подтверждения §6.3, платёжного контура нет — финмодель v2);
 * страница только группирует и суммирует по валютам через `Money` (разные
 * валюты не складываются по построению — по итогу на валюту).
 *
 * Раскладка — строка доски A (ADR-152). Замечание владельца 03.09: «платежи
 * тоже с рамкой, редактируй дизайн». Карточка на группу и бейдж статуса
 * ушли: группа подписана `SectionLabel`, строки лежат на одной поверхности
 * (`Surface bleed`), сумма стоит справа на первой строке.
 *
 * Статуса СЛОВОМ (`StatusWord`) в строке здесь НЕТ — в отличие от «Сделок»
 * (решение владельца 05.09). На «Сделках» строки одного списка несут разные
 * состояния, и слово — единственный их различитель; здесь состояние платежа
 * и есть признак группировки, поэтому слово повторяло бы подпись группы
 * буква в букву. Плата за дубль видна на 360px: `.status` в `ListRow` не
 * сжимается (`flex: none`), и лишнее слово усекало имя контрагента во второй
 * строке. Убрали дубль — вернули ширину имени.
 */

const GROUPS: { state: PaymentSectionState; labelKey: string }[] = [
  { state: 'awaiting_confirmation', labelKey: 'dashboard.paymentsGroupAwaiting' },
  { state: 'upcoming', labelKey: 'dashboard.paymentsGroupUpcoming' },
  { state: 'paid', labelKey: 'dashboard.paymentsGroupPaid' },
];

function totalsByCurrency(items: PaymentSectionItem[]): Money[] {
  const byCurrency = new Map<string, Money>();
  for (const item of items) {
    const money = Money.of(item.amount, item.amount_currency);
    const current = byCurrency.get(item.amount_currency);
    byCurrency.set(item.amount_currency, current ? current.add(money) : money);
  }
  return Array.from(byCurrency.values());
}

export function PaymentsPage(): JSX.Element {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const { data, isPending, error, refetch } = usePaymentsSection();

  if (isPending) {
    return (
      <div className={styles.loading} aria-busy="true">
        <Skeleton height={54} radius="var(--pr-d-r-surface)" />
        <Skeleton height={54} radius="var(--pr-d-r-surface)" />
        <Skeleton height={54} radius="var(--pr-d-r-surface)" />
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
    return (
      <EmptyState icon="wallet" title={t('dashboard.paymentsEmptyTitle')} text={t('dashboard.paymentsEmptyText')} />
    );
  }

  return (
    <div className={styles.groups} data-testid="payments-groups">
      {GROUPS.map(({ state, labelKey }) => {
        const items = data.items.filter((item) => item.state === state);
        if (items.length === 0) return null;
        return (
          <section key={state} aria-label={t(labelKey)} className={styles.group}>
            <SectionLabel
              aside={
                <span className={styles.groupTotal}>
                  {totalsByCurrency(items)
                    .map((total) => t('dashboard.paymentsGroupTotal', { sum: formatMoney(total, i18n.language) }))
                    .join(' · ')}
                </span>
              }
            >
              {t(labelKey)}
            </SectionLabel>
            <Surface bleed>
              {items.map((item) => (
                <ListRow
                  key={item.milestone_id}
                  avatarName={item.counterparty.display_name ?? t('dashboard.sectionCounterpartyFallback')}
                  /* Владелец 08.09: фото контрагента напротив сделки (ADR-173);
                     null (нет фото либо deals_only) — инициалы, как раньше. */
                  avatarSrc={item.counterparty.avatar_url ?? undefined}
                  title={item.milestone_title}
                  amount={formatMoney({ amount: item.amount, currency: item.amount_currency }, i18n.language)}
                  meta={
                    <>
                      {item.contract_title}
                      {' · '}
                      {/* Бэклог 2026-08-21: контрагент кликабелен и в разделах. */}
                      <CounterpartyLink
                        profileId={item.counterparty.profile_id}
                        name={item.counterparty.display_name ?? t('dashboard.sectionCounterpartyFallback')}
                        showHandle={false}
                        plain
                      />
                    </>
                  }
                  // Третьей строкой — только то, что не влезло в ритм строки:
                  // срок ближайшего платежа и чьё подтверждение уже стоит.
                  extra={
                    [
                      item.deadline && state === 'upcoming'
                        ? t('dashboard.stageDeadline', { date: formatShortDate(item.deadline, i18n.language) })
                        : null,
                      state === 'awaiting_confirmation' && item.paid_confirmed_by_me
                        ? t('dashboard.paymentsConfirmedByMe')
                        : null,
                      state === 'awaiting_confirmation' && item.paid_confirmed_by_counterparty
                        ? t('dashboard.paymentsConfirmedByCounterparty')
                        : null,
                    ]
                      .filter(Boolean)
                      .join(' · ') || undefined
                  }
                  ariaLabel={item.milestone_title}
                  onOpen={() => navigate(`/contracts/${item.contract_id}`)}
                />
              ))}
            </Surface>
          </section>
        );
      })}
    </div>
  );
}
