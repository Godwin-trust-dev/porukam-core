import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ApiError, type DashboardAttentionItem, type DashboardAttentionKind } from '@porukam/core';
import {
  AttentionCard,
  Button,
  EmptyState,
  ErrorState,
  Fab,
  FreshProfileCard,
  RailLayout,
  SectionLabel,
  Skeleton,
  Surface,
  type BadgeTone,
} from '@porukam/ui';
import { useCurrentUser } from '../features/auth/useAuth';
import { useAuthStore } from '../features/auth/authStore';
import { useDashboard } from '../features/dashboard/api';
import { useRealContractsList } from '../features/contracts/realApi';
import { bucketOf } from '../features/contracts/realStatus';
import { useOpenWarrantyClaims } from '../features/contracts/useOpenWarrantyClaims';
import { RealContractRow } from '../features/contracts/RealContractRow';
import { DashboardRail } from '../features/dashboard/DashboardRail';
import { ActiveDisputeWindows } from '../features/disputes/DisputeWindowsList';
import { useFormatters } from '../shared/formatters';
import styles from './DashboardPage.module.css';
import { isFeatureEnabled } from '../shared/features';
import { apiErrorText } from '../shared/apiErrorText';

const ATTENTION_TITLE_KEY: Record<DashboardAttentionKind, string> = {
  signature: 'dashboard.attentionSignatureTitle',
  acceptance: 'dashboard.attentionAcceptanceTitle',
  submission: 'dashboard.attentionSubmissionTitle',
};

const ATTENTION_ACTION_LABEL_KEY: Record<DashboardAttentionKind, string> = {
  signature: 'dashboard.actionSign',
  acceptance: 'dashboard.actionOpenAcceptance',
  submission: 'dashboard.actionOpenAcceptance',
};

/** Короткая подпись кнопки для телефона (замечание владельца 06.09): «Открыть»
    вместо «Открыть приёмку»; «Подписать» и так короткое — без замены. */
const ATTENTION_ACTION_SHORT_LABEL_KEY: Partial<Record<DashboardAttentionKind, string>> = {
  acceptance: 'contracts.actionOpen',
  submission: 'contracts.actionOpen',
};

/** Чип рода события (compact-десктоп: «● Приёмка» янтарный, «Оплата» бирюзовый). */
const ATTENTION_KIND_LABEL_KEY: Record<DashboardAttentionKind, string> = {
  signature: 'dashboard.attentionKindSignature',
  acceptance: 'dashboard.attentionKindAcceptance',
  submission: 'dashboard.attentionKindSubmission',
};
const ATTENTION_KIND_TONE: Record<DashboardAttentionKind, BadgeTone> = {
  signature: 'teal',
  acceptance: 'amber',
  submission: 'amber',
};

/**
 * Дашбордная доводка (план интеграции, §E-смоук 2026-08-18): `acceptance`/
 * `submission` — сразу на РЕАЛЬНУЮ страницу этапа (`StagePage`, ADR-088 Фазы
 * 5–6: сдача и приёмка живут там), не на карточку договора. `milestone_id`
 * достаём из составного `id` («"<kind>:<uuid>"», ADR-090 §2 — сериализатор
 * отдаёт его именно для этого); повреждённый id — честный фолбэк на
 * карточку. `signature` — на `SigningPage`, как и было.
 */
function attentionRoute(item: DashboardAttentionItem): string {
  if (item.kind === 'signature') return `/contracts/${item.contract_id}/sign`;
  const milestoneId = item.id.split(':')[1];
  return milestoneId
    ? `/contracts/${item.contract_id}/stages/${milestoneId}`
    : `/contracts/${item.contract_id}`;
}

const CONTRACTS_PREVIEW_LIMIT = 5;

/**
 * Дашборд — «рабочий стол» (DEV-03, ADR-090): `/` после входа. Минимальный
 * дашборд запуска — ТОЛЬКО «требует моего действия» (`GET /v1/dashboard`,
 * cross-cutting по всем сделкам) + короткий превью «мои сделки», который
 * переиспользует уже реальный `GET /v1/contracts` (`useRealContractsList`,
 * `RealContractRow` — тот же компонент, что `/contracts`, ADR-090 §1: не
 * второй агрегат тех же данных под другим путём). Без денежной панели/
 * периодов/хранения доказательств/ленты событий (постановка задачи).
 */
export function DashboardPage(): JSX.Element {
  const { t } = useTranslation();
  const { formatCountdown } = useFormatters();
  const navigate = useNavigate();
  const { data: me } = useCurrentUser();
  const isGoogleSession = useAuthStore((s) => s.loginMethod) === 'google';

  const attentionQ = useDashboard();
  const contractsQ = useRealContractsList({});
  const openWarrantyClaims = useOpenWarrantyClaims();

  if (contractsQ.isPending) {
    return (
      <div className={styles.page} aria-busy="true">
        <Skeleton width="100%" height={72} radius="var(--pr-d-r-surface)" />
        <Skeleton width="100%" height={240} radius="var(--pr-d-r-surface)" />
      </div>
    );
  }

  if (contractsQ.error || !contractsQ.data) {
    return (
      <div className={styles.page}>
        <ErrorState
          title={t('dashboard.errorText')}
          text={apiErrorText(contractsQ.error)}
          code={contractsQ.error instanceof ApiError ? contractsQ.error.code : undefined}
          retryLabel={t('common.retry')}
          onRetry={() => void contractsQ.refetch()}
        />
      </div>
    );
  }

  const contracts = contractsQ.data;
  // ADR-088 решение 1 / ADR-090: та же деградация, что `useRealContractView`
  // — сделки первичны для этого экрана, `attention` при СВОЕЙ ошибке
  // деградирует до [] (не роняет весь дашборд ради вторичной полосы).
  const attention = attentionQ.data?.attention ?? [];

  if (attention.length === 0 && contracts.length === 0) {
    return (
      <div className={styles.page}>
        {isGoogleSession && me ? (
          // GLOBAL У1 (DEV-auth-onboarding §7, док 31 §3 «зеркало, а не гарант»):
          // свежий профиль показан честно, не спрятан за общей пустой заглушкой.
          <FreshProfileCard
            title={t('onboarding.freshTitle')}
            ageLabel={t('onboarding.freshAge')}
            dealsLabel={t('onboarding.freshDeals', { count: 0 })}
            contactsLabel={t('onboarding.freshContacts', { count: me.savedContactsCount })}
            createCtaLabel={t('onboarding.freshCreateCta')}
            onCreateCta={() => navigate('/contracts/new')}
            inviteCtaLabel={t('onboarding.freshInviteCta')}
            onInviteCta={() => navigate('/me')}
          />
        ) : null}
        <EmptyState
          icon="deals"
          title={t('dashboard.emptyTitle')}
          text={t('dashboard.emptyText')}
          actionLabel={t('dashboard.emptyActionCreate')}
          onAction={() => navigate('/contracts/new')}
          // DEV-17 §3: вторичное действие внутри компактного блока состояния,
          // а не отдельная ghost-полоса на всю ширину под ним.
          secondaryActionLabel={isFeatureEnabled('search') ? t('dashboard.emptyActionFind') : undefined}
          onSecondaryAction={isFeatureEnabled('search') ? () => navigate('/search') : undefined}
        />
      </div>
    );
  }

  // Замечание владельца 28.08: на главной висели ВСЕ сделки — черновики,
  // отклонённые и архивные вперемешку с работой. Рабочий стол показывает
  // только активные (`bucketOf`, та же функция, что вкладки /contracts и
  // счётчики рейла — второго определения «активной сделки» в продукте нет);
  // черновики и архив остаются доступны вкладками списка.
  const active = contracts.filter((c) => bucketOf(c, openWarrantyClaims) === 'active');
  const preview = [...active].sort((a, b) => (a.created_at < b.created_at ? 1 : -1)).slice(0, CONTRACTS_PREVIEW_LIMIT);

  return (
    /* DEV-19 §3: `≥1024` — главный столбец (внимание + грид сделок) и правый
       рейл; `<1024` — тот же порядок в один столбец, рейл уходит вниз. */
    <RailLayout railLabel={t('dashboard.title')} rail={<DashboardRail contracts={contracts} openWarrantyClaims={openWarrantyClaims} />}>
      {/* Активные окна оспаривания (ADR-019, этап 7): срок идёт, а возражение
          подаётся одним нажатием. Пустой список сам себя не рисует. */}
      <ActiveDisputeWindows />

      {attention.length > 0 ? (
        <section aria-label={t('dashboard.attentionTitle')}>
          <SectionLabel>{t('dashboard.attentionTitle')}</SectionLabel>
          {/* DEV-20 §2/§5: пункты — строки на ОДНОЙ поверхности, а не
              карточка с рамкой на каждый; на телефоне — во всю ширину
              (финал доска A). */}
          <Surface bleed data-testid="dashboard-attention">
            {attention.map((item) => (
              <AttentionCard
                key={item.id}
                side={item.side}
                sideLabel={t(item.side === 'customer' ? 'dashboard.sideCustomer' : 'dashboard.sideContractor')}
                kindLabel={t(ATTENTION_KIND_LABEL_KEY[item.kind])}
                kindTone={ATTENTION_KIND_TONE[item.kind]}
                /* `timer`, а не `deadline`: значение — обратный отсчёт
                   (`formatCountdown`), и рядом с ним нужны часы, а не
                   календарь (замечание владельца 09.09 — «таймер»). */
                urgency={item.deadline_at ? { kind: 'timer', value: formatCountdown(item.deadline_at, Date.now()) } : undefined}
                title={t(ATTENTION_TITLE_KEY[item.kind], { title: item.title })}
                /* Телефон (замечание владельца 09.09): вместо целой фразы —
                   одно название договора/этапа; что случилось, уже сказал
                   чип рода слева. */
                shortTitle={item.title}
                action={{
                  label: t(ATTENTION_ACTION_LABEL_KEY[item.kind]),
                  shortLabel: ATTENTION_ACTION_SHORT_LABEL_KEY[item.kind]
                    ? t(ATTENTION_ACTION_SHORT_LABEL_KEY[item.kind] as string)
                    : undefined,
                }}
                onAction={() => navigate(attentionRoute(item))}
              />
            ))}
          </Surface>
        </section>
      ) : null}

      <section aria-label={t('dashboard.contractsTitle')}>
        {/* Финал доска A / compact-десктоп: надпись «АКТИВНЫЕ ДОГОВОРЫ» и
            справа ссылка «Все сделки». Кнопки «Создать» в шапке раздела нет
            ни на одном эталоне: на телефоне создаёт FAB, на десктопе —
            «+ Создать» на экране сделок. */}
        <SectionLabel
          level={3}
          aside={
            /* «Все сделки» ведёт на /contracts и когда активных больше пяти,
               и когда активных нет вовсе, а черновики с архивом есть: иначе
               с рабочего стола к ним не попасть — раньше они лежали тут. */
            active.length > CONTRACTS_PREVIEW_LIMIT || contracts.length > active.length ? (
              <Button variant="link" size="sm" onClick={() => navigate('/contracts')}>
                {t('dashboard.seeAllContracts')}
              </Button>
            ) : undefined
          }
        >
          {t('dashboard.contractsTitle')}
        </SectionLabel>
        {preview.length === 0 ? (
          <EmptyState icon="deals" title={t('dashboard.emptyTitle')} text={t('dashboard.emptyText')} />
        ) : (
          /* DEV-20 §5 (заменяет грид плиток DEV-19 §3): сделки — те же строки,
             что на `/contracts`, на одной поверхности; на телефоне — во всю
             ширину без рамки (финал доска A). */
          <Surface bleed data-testid="dashboard-contracts">
            {preview.map((c) => (
              <RealContractRow
                key={c.id}
                contract={c}
                onOpen={() => navigate(`/contracts/${c.id}`)}
                onOpenId={(id) => navigate(`/contracts/${id}`)}
              />
            ))}
          </Surface>
        )}
      </section>

      {/* «Создать» на списках — FAB (DEV-20_2 §5). */}
      <Fab label={t('contract.create')} onClick={() => navigate('/contracts/new')} data-testid="dashboard-create-fab" />
    </RailLayout>
  );
}
