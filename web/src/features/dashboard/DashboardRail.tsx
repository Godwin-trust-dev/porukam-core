import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { MoneyLike, RealContract } from '@porukam/core';
import { Badge, Button, LtrText, SummaryCard, type SummaryStatLinkProps } from '@porukam/ui';
import { useCurrentUser } from '../auth/useAuth';
import { bucketOf } from '../contracts/realStatus';
import { useFormatters } from '../../shared/formatters';
import styles from './DashboardRail.module.css';

/** Ссылка плитки-счётчика: маршруты знает страница, `@porukam/ui` роутер не
    тянет. Объявлена на уровне модуля — иначе новый тип компонента на каждый
    рендер и лишний размонтаж ссылки. */
function StatLink({ to, className, children }: SummaryStatLinkProps): JSX.Element {
  return (
    <Link to={to} className={className}>
      {children}
    </Link>
  );
}

const VERIFICATION_KEY = ['profile.verificationNone', 'profile.verificationPhone', 'profile.verificationBasic', 'profile.verificationVerified'] as const;

/**
 * Суммы активных сделок ПО ВАЛЮТАМ (доменный инвариант: Money не складывает
 * разные валюты, валюты по умолчанию нет). Порядок — по убыванию суммы, чтобы
 * основная валюта пользователя стояла первой.
 */
export function activeTotalsByCurrency(contracts: RealContract[], openWarrantyClaims?: ReadonlySet<string>): MoneyLike[] {
  const sums = new Map<string, number>();
  for (const c of contracts) {
    if (bucketOf(c, openWarrantyClaims) !== 'active' || !c.total) continue;
    sums.set(c.total.currency, (sums.get(c.total.currency) ?? 0) + Number(c.total.amount));
  }
  return [...sums.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([currency, amount]) => ({ amount: amount.toFixed(2), currency }));
}

/**
 * Правый рейл дашборда (DEV-19 §3, эталон №4 блок 1): деньги/счётчики и
 * мини-профиль. Новых запросов и полей не заводит — считает по уже
 * загруженному списку сделок (`GET /v1/contracts`) и `/users/me`.
 */
export function DashboardRail({
  contracts,
  openWarrantyClaims,
}: {
  contracts: RealContract[];
  /** Договоры с открытым гарантийным случаем — они считаются активными
      (решение владельца 31.08, см. `bucketOf`). */
  openWarrantyClaims?: ReadonlySet<string>;
}): JSX.Element {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { formatMoney } = useFormatters();
  const { data: me } = useCurrentUser();

  const totals = activeTotalsByCurrency(contracts, openWarrantyClaims);
  const activeCount = contracts.filter((c) => bucketOf(c, openWarrantyClaims) === 'active').length;
  const archiveCount = contracts.filter((c) => bucketOf(c, openWarrantyClaims) === 'archive').length;
  const handle = me?.handle ?? '';

  return (
    <>
      <SummaryCard
        eyebrow={t('dashboard.railMoneyTitle')}
        values={totals.length > 0 ? totals.map((m) => formatMoney(m)) : undefined}
        note={totals.length === 0 ? t('contracts.amountUnset') : undefined}
        // Счётчики — входы на соответствующую вкладку «Сделок» (решение
        // владельца 05.09): вкладку выбирает `?tab=` (`ContractsListPage`),
        // причём «активные» — состояние по умолчанию, поэтому без параметра.
        // `Link` роутера, а не `<a href>`: перезагрузка потеряла бы токены
        // (они живут в памяти).
        statLinkAs={StatLink}
        stats={[
          { label: t('contracts.tabActive'), value: String(activeCount), to: '/contracts' },
          { label: t('contracts.tab_archive'), value: String(archiveCount), to: '/contracts?tab=archive' },
        ]}
      />

      {/* Мини-профиль — только рейл десктопа (compact-десктоп): на телефоне
          под списком стоит одна карточка «Деньги» (финал доска A), профиль
          у телефона — своя вкладка. */}
      {me ? (
        <div className={styles.desktopOnly}>
        <SummaryCard eyebrow={t('profile.title')}>
          <div className={styles.profileRows}>
            <p className={styles.profileName}>{me.display_name}</p>
            {handle ? (
              <LtrText as="span" className={styles.handle}>
                {handle}
              </LtrText>
            ) : null}
            <div className={styles.profileFoot}>
              <Badge tone={me.verificationLevel >= 3 ? 'green' : 'neutral'} dot>
                {t(VERIFICATION_KEY[Math.min(me.verificationLevel, 3)] ?? VERIFICATION_KEY[0])}
              </Badge>
            </div>
            <p className={styles.hint}>{me.reputation_hint ?? t('profile.reputationEmpty')}</p>
            <div className={styles.profileFoot}>
              <Button variant="ghost" size="sm" onClick={() => navigate(handle ? `/${handle}` : '/me')}>
                {t('profile.reputationOpenCard')}
              </Button>
            </div>
          </div>
        </SummaryCard>
        </div>
      ) : null}
    </>
  );
}
