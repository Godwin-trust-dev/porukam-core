import { useState } from 'react';
import { Navigate, Outlet, useLocation, useNavigate, useOutletContext, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  ApiError,
  computeCardStatus,
  type ContractAttention,
  type ContractCardStatus,
  type ContractDetail,
  type MaterialState,
  type NegotiationStatus,
  type RevisionAuthorRole,
  type StageStatus,
} from '@porukam/core';
import {
  AmendmentsBlock,
  AttentionCard,
  Button,
  Callout,
  ContractHeader,
  ContractTimeline,
  ErrorState,
  LtrText,
  MoneyPanel,
  PartyRow,
  PaymentPlan,
  PaymentPolicyLine,
  Skeleton,
  StageMaterials,
  ScreenTabs,
  StageTree,
} from '@porukam/ui';
import { useContract, useContractHistory, usePaymentPlan, useStages } from '../features/contracts/api';
import { isRealContractId } from '../features/contracts/realDispatch';
import { useViewerStore } from '../features/contracts/viewerStore';
import { useFormatters } from '../shared/formatters';
import styles from './ContractPage.module.css';
import { isFeatureEnabled } from '../shared/features';

const STATUS_LABEL_KEY: Record<ContractCardStatus, string> = {
  draft: 'contract.card.statusDraft',
  under_review: 'contract.card.statusUnderReview',
  rejected_by_counterparty: 'contract.card.statusRejectedByCounterparty',
  withdrawn_by_initiator: 'contract.card.statusWithdrawnByInitiator',
  pending_signature: 'contract.card.statusPendingSignature',
  awaiting_signatures: 'contract.card.statusAwaitingSignatures',
  signed: 'contract.card.statusSigned',
  in_progress: 'contract.card.statusInProgress',
  suspended: 'contract.card.statusSuspended',
  completed: 'contract.card.statusCompleted',
  terminated_by_customer: 'contract.card.statusTerminatedByCustomer',
  terminated_by_contractor: 'contract.card.statusTerminatedByContractor',
  under_warranty: 'contract.card.statusUnderWarranty',
  warranty_claim: 'contract.card.statusWarrantyClaim',
};

const PAYMENT_METHOD_KEY: Record<string, string> = {
  cash: 'dashboard.paymentCash',
  bank: 'dashboard.paymentBank',
  sbp: 'dashboard.paymentSbp',
};

interface CardContext {
  c: ContractDetail;
  viewerRole: RevisionAuthorRole;
  stub: (route: string) => void;
}

/** DEV-06 · Карточка договора (Обзор + вкладки) — `/contracts/:id/{overview,stages,money,history}`. */
export function ContractPage(): JSX.Element {
  const { id = '' } = useParams();
  // Отсмотр 2026-08-21: вкладки /overview|/stages|/money|/history — старый
  // мок-агрегат (ContractDetail c milestones/signatures/revisions). Реальный
  // /contracts/{id} этих полей не отдаёт → `c.milestones.some` ронял экран
  // «Cannot read properties of undefined (reading 'some')». В реальном контуре
  // всё это живёт в ContractDetailPage — уводим туда (ADR-088, isRealContractId).
  if (isRealContractId(id)) return <Navigate to={`/contracts/${id}`} replace />;
  return <LegacyContractPage id={id} />;
}

function LegacyContractPage({ id }: { id: string }): JSX.Element {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const { data: c, isPending, error, refetch } = useContract(id);
  const viewerRole = useViewerStore((s) => s.viewAs);
  const [stubMessage, setStubMessage] = useState<string | null>(null);

  if (isPending || !c) {
    return (
      <div className={styles.wrap}>
        <Skeleton width="70%" height={28} />
        <Skeleton width="100%" height={80} radius="var(--pr-r-lg)" />
        <Skeleton width="100%" height={160} radius="var(--pr-r-lg)" />
      </div>
    );
  }

  if (error) {
    const code = error instanceof ApiError ? error.code : undefined;
    if (code === 'not_found') {
      return (
        <div className={styles.wrap}>
          <ErrorState title={t('contract.card.notFoundTitle')} onRetry={undefined} />
          <p className={styles.notFoundText}>{t('contract.card.notFoundText')}</p>
        </div>
      );
    }
    return (
      <div className={styles.wrap}>
        <ErrorState title={t('contract.card.errorText')} code={code} retryLabel={t('common.retry')} onRetry={() => void refetch()} />
      </div>
    );
  }

  const hasSuspendedStage = c.milestones.some((m) => m.status === 'suspended');
  const cardStatus = computeCardStatus({ status: c.status, execution: c.execution, hasSuspendedStage });
  const leaves = c.milestones.filter((m) => m.kind === 'leaf');
  const currentIx = leaves.findIndex((m) => m.status === 'in_progress' || m.status === 'under_acceptance' || m.status === 'submitted');
  const stageCaption =
    cardStatus === 'in_progress' || cardStatus === 'suspended'
      ? t('contract.card.stageCaption', { n: currentIx >= 0 ? currentIx + 1 : leaves.length, of: leaves.length })
      : undefined;

  const counterparty = c.parties.find((p) => p.role !== viewerRole);
  const hashShort = c.version ? `${c.version.integrity_hash.slice(0, 18)}…` : '';

  const activeTab = location.pathname.split('/').pop() ?? 'overview';

  function stub(route: string): void {
    const MESSAGES: Record<string, string> = {
      remind: 'contract.card.attentionRemind',
      'create-amendment': 'contract.card.attentionCreateAmendment',
      terminate: 'contract.card.attentionTerminate',
      'warranty-claim': 'contract.card.attentionWarrantyClaim',
    };
    setStubMessage(t(MESSAGES[route] ?? route));
  }

  return (
    <div className={styles.wrap}>
      <ContractHeader
        title={c.title}
        no={c.no ?? c.id}
        counterparty={{
          name: counterparty?.display_name ?? '',
          onOpen: () => counterparty && navigate(`/${counterparty.handle.replace(/^@?/, '@')}`),
        }}
        viewerRoleLabel={t(viewerRole === 'customer' ? 'contract.card.viewerRoleCustomer' : 'contract.card.viewerRoleContractor')}
        status={cardStatus}
        statusLabel={t(STATUS_LABEL_KEY[cardStatus])}
        stageCaption={stageCaption}
        sum={c.total}
        paymentMethodLabel={c.payment_method ? t(PAYMENT_METHOD_KEY[c.payment_method] ?? '') : ''}
        version={c.version ? { short: hashShort, onOpen: () => navigate(`/contracts/${id}`) } : undefined}
        versionLabel={t('contract.card.versionLabel')}
      />

      {stubMessage ? <Callout tone="neutral">{stubMessage}</Callout> : null}

      <div className={styles.chips} role="group" aria-label={t('contract.viewAsHint')}>
        <Button
          variant={viewerRole === 'customer' ? 'primary' : 'ghost'}
          size="sm"
          onClick={() => useViewerStore.getState().setViewAs('customer')}
          data-testid="viewas-customer"
        >
          {t('contract.roleCustomer')}
        </Button>
        <Button
          variant={viewerRole === 'contractor' ? 'primary' : 'ghost'}
          size="sm"
          onClick={() => useViewerStore.getState().setViewAs('contractor')}
          data-testid="viewas-contractor"
        >
          {t('contract.roleContractor')}
        </Button>
      </div>

      {/* DEV-20_2 §3: четыре коротких вкладки — без бокового скролла. */}
      <ScreenTabs
        active={activeTab}
        onChange={(key) => navigate(`/contracts/${id}/${key}`)}
        ariaLabel={c.title}
        allowExtra
        items={[
          { key: 'overview', label: t('contract.tabs.overview') },
          { key: 'stages', label: t('contract.tabs.stages') },
          { key: 'money', label: t('contract.tabs.money') },
          { key: 'history', label: t('contract.tabs.timeline') },
        ]}
      />

      <Outlet context={{ c, viewerRole, stub } satisfies CardContext} />
    </div>
  );
}

function useCard(): CardContext {
  return useOutletContext<CardContext>();
}

// ─────────────────────────────────────────── Обзор
export function ContractOverviewTab(): JSX.Element {
  const { t } = useTranslation();
  const { formatDate } = useFormatters();
  const navigate = useNavigate();
  const { id = '' } = useParams();
  const { c, viewerRole, stub } = useCard();

  const leaves = c.milestones.filter((m) => m.kind === 'leaf');
  const acceptedCount = leaves.filter((m) => m.status === 'accepted' || m.status === 'paid').length;
  const progressPct = leaves.length > 0 ? Math.round((acceptedCount / leaves.length) * 100) : 0;
  const custParty = c.parties.find((p) => p.role === 'customer');
  const contrParty = c.parties.find((p) => p.role === 'contractor');

  const attention: ContractAttention | null | undefined = c.attention;
  const view = attention?.views[viewerRole];

  function attentionAction(route?: string): (() => void) | undefined {
    if (!route) return undefined;
    if (route === 'accept' && attention?.milestone_id) {
      return () => navigate(`/contracts/${id}/milestones/${attention.milestone_id}/accept`);
    }
    if (route === 'pay') {
      return attention?.milestone_id
        ? () => navigate(`/contracts/${id}/payments/new?stage=${attention.milestone_id}`)
        : () => navigate(`/contracts/${id}/money`);
    }
    if (route === 'chat') return isFeatureEnabled('chat') ? () => navigate('/chat') : undefined;
    return () => stub(route);
  }

  return (
    <div className={styles.tab}>
      {view ? (
        <AttentionCard
          side={viewerRole}
          sideLabel={t(viewerRole === 'customer' ? 'contract.roleCustomer' : 'contract.roleContractor')}
          title={view.title}
          action={view.primary ? { label: view.primary.label } : undefined}
          onAction={attentionAction(view.primary?.route)}
          info={
            view.info
              ? {
                  text: view.info.text,
                  note: view.info.note,
                  secondaryAction: view.info.secondaryLabel
                    ? { label: view.info.secondaryLabel, onAction: attentionAction(view.info.secondaryRoute) ?? (() => {}) }
                    : undefined,
                }
              : undefined
          }
        />
      ) : null}

      <div className={styles.card}>
        <h3 className={styles.sectionTitle}>{t('contract.card.progressTitle')}</h3>
        <div className={styles.progressBar} data-testid="stage-progress">
          <div className={styles.progressFill} style={{ width: `${progressPct}%` }} />
        </div>
        <p className={styles.progressCaption}>{t('contract.card.progressCaption', { accepted: acceptedCount, total: leaves.length })}</p>
      </div>

      <MoneyPanel
        role={viewerRole}
        paidPct={c.total.amount !== '0.00' ? Math.round((leaves.filter((m) => m.status === 'accepted' || m.status === 'paid').reduce((s, m) => s + Number(m.amount?.amount ?? 0), 0) / Number(c.total.amount)) * 100) : 0}
        paidPctLabel={t('contract.card.moneyPaidPctLabel')}
        receivedLabel={t('contract.card.moneyPaidLabel')}
        received={{
          amount: leaves
            .filter((m) => m.status === 'accepted' || m.status === 'paid')
            .reduce((s, m) => s + Number(m.amount?.amount ?? 0), 0)
            .toFixed(2),
          currency: c.total.currency,
        }}
        expectedLabel={t('contract.card.moneyRemainingLabel')}
        expected={{
          amount: (Number(c.total.amount) - leaves.filter((m) => m.status === 'accepted' || m.status === 'paid').reduce((s, m) => s + Number(m.amount?.amount ?? 0), 0)).toFixed(2),
          currency: c.total.currency,
        }}
        methodLabel={c.payment_method ? t('contract.card.moneyMethodLabel') : undefined}
        method={c.payment_method ? t(PAYMENT_METHOD_KEY[c.payment_method] ?? '') : undefined}
      />

      <div className={styles.card}>
        <h3 className={styles.sectionTitle}>{t('contract.card.partiesTitle')}</h3>
        {custParty ? (
          <PartyRow
            name={custParty.display_name}
            role={t('contract.roleCustomer')}
            signState="signed"
            signedAt={c.signatures.find((s) => s.role === 'customer')?.signed_at}
            signedLabel={t('contract.card.partySigned')}
            pendingLabel={t('contract.card.partyPending')}
          />
        ) : null}
        {contrParty ? (
          <PartyRow
            name={contrParty.display_name}
            role={t('contract.roleContractor')}
            signState="signed"
            signedAt={c.signatures.find((s) => s.role === 'contractor')?.signed_at}
            signedLabel={t('contract.card.partySigned')}
            pendingLabel={t('contract.card.partyPending')}
          />
        ) : null}
      </div>

      {c.dates ? (
        <div className={styles.card}>
          <h3 className={styles.sectionTitle}>{t('contract.card.datesTitle')}</h3>
          {c.dates.start ? (
            <p className={styles.dateRow}>
              {t('contract.card.dateStart')}: <LtrText as="span">{formatDate(c.dates.start, { legal: true })}</LtrText>
            </p>
          ) : null}
          {c.dates.finish ? (
            <p className={styles.dateRow}>
              {t('contract.card.dateFinish')}: <LtrText as="span">{formatDate(c.dates.finish, { legal: true })}</LtrText>
            </p>
          ) : null}
          {c.dates.nearest ? (
            <p className={styles.dateRow}>
              {t('contract.card.dateNearest')}: <LtrText as="span">{formatDate(c.dates.nearest, { legal: true })}</LtrText>
            </p>
          ) : null}
        </div>
      ) : null}

      <div className={styles.chips}>
        <Button variant="ghost" size="sm" onClick={() => navigate(`/contracts/${id}`)}>
          {t('contract.card.fullTextChip')}
        </Button>
        <Button variant="ghost" size="sm" onClick={() => navigate(`/contracts/${id}/stages`)}>
          {t('contract.card.materialsChip')}
        </Button>
        <Button variant="ghost" size="sm" onClick={() => navigate(`/contracts/${id}/history`)}>
          {t('contract.card.amendmentsChip')}
        </Button>
      </div>

      {isFeatureEnabled('chat') ? (
        <Button variant="secondary" block onClick={() => navigate('/chat')}>
          {t('contract.card.chatCta')}
        </Button>
      ) : null}
    </div>
  );
}

// ─────────────────────────────────────────── Этапы
export function ContractStagesTab(): JSX.Element {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { id = '' } = useParams();
  const { c, stub } = useCard();
  const { data: stages, isPending } = useStages(id);

  if (isPending || !stages) {
    return (
      <div className={styles.tab}>
        <Skeleton width="100%" height={220} radius="var(--pr-r-lg)" />
      </div>
    );
  }

  const OPENABLE: StageStatus[] = ['in_progress', 'under_acceptance', 'submitted'];
  const currentStage = stages.find((s) => s.status && OPENABLE.includes(s.status));

  const STAGE_STATUS_LABEL: Record<StageStatus, string> = {
    waiting_gate: t('contract.card.stageStatusWaitingGate'),
    in_progress: t('contract.card.stageStatusInProgress'),
    submitted: t('contract.card.stageStatusSubmitted'),
    under_acceptance: t('contract.card.stageStatusUnderAcceptance'),
    accepted: t('contract.card.stageStatusAccepted'),
    dispute: t('contract.card.stageStatusDispute'),
    suspended: t('contract.card.stageStatusSuspended'),
    paid: t('contract.card.stageStatusPaid'),
  };

  const MATERIAL_STATE_LABEL: Record<MaterialState, string> = {
    received: t('contract.card.materialReceived'),
    expected: t('contract.card.materialExpected'),
    problem: t('contract.card.materialProblem'),
  };

  return (
    <div className={styles.tab}>
      <StageTree
        stages={stages.map((s) => ({
          id: s.id,
          ix: s.ix as number,
          name: s.name as string,
          meta: s.meta,
          sum: s.sum!,
          // До начала исполнения (черновик/согласование) статуса у листа нет —
          // StageTree тогда не рендерит чип (пустой серый бейдж был дефектом).
          status: s.status,
          statusLabel: s.status ? STAGE_STATUS_LABEL[s.status] : undefined,
        }))}
        onOpen={(msId) => navigate(`/contracts/${id}/milestones/${msId}/accept`)}
        openLabel={t('contract.card.stageOpenLabel')}
      />

      {currentStage && currentStage.materials && currentStage.materials.length > 0 ? (
        <div className={styles.card}>
          <h3 className={styles.sectionTitle}>{currentStage.name}</h3>
          <StageMaterials
            materials={currentStage.materials.map((m) => ({ id: m.id, name: m.title, suppliedBy: m.supplied_by ?? '', due: m.due ?? undefined, state: m.state ?? 'expected' }))}
            stateLabels={MATERIAL_STATE_LABEL}
            onOpenProblem={() => stub('material-problem')}
            problemActionLabel={t('contract.card.materialProblemAction')}
            problemNote={t('contract.card.materialProblemNote')}
          />
        </div>
      ) : null}
      {c.attention?.kind === 'suspended_materials' ? (
        <Callout tone="warn">{t('contract.card.suspendedNote')}</Callout>
      ) : null}
    </div>
  );
}

// ─────────────────────────────────────────── Деньги
export function ContractMoneyTab(): JSX.Element {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { id = '' } = useParams();
  const { c, viewerRole } = useCard();
  const { data: plan, isPending } = usePaymentPlan(id);

  if (isPending || !plan) {
    return (
      <div className={styles.tab}>
        <Skeleton width="100%" height={200} radius="var(--pr-r-lg)" />
      </div>
    );
  }

  const paidTotal = plan.rows.filter((r) => r.state === 'paid').reduce((s, r) => s + Number(r.amount.amount), 0);
  const paidPct = c.total.amount !== '0.00' && Number(c.total.amount) > 0 ? Math.round((paidTotal / Number(c.total.amount)) * 100) : 0;

  return (
    <div className={styles.tab}>
      <MoneyPanel
        role={viewerRole}
        paidPct={paidPct}
        paidPctLabel={t('contract.card.moneyPaidPctLabel')}
        receivedLabel={t('contract.card.moneyPaidLabel')}
        received={{ amount: paidTotal.toFixed(2), currency: c.total.currency }}
        expectedLabel={t('contract.card.moneyRemainingLabel')}
        expected={{ amount: (Number(c.total.amount) - paidTotal).toFixed(2), currency: c.total.currency }}
        methodLabel={c.payment_method ? t('contract.card.moneyMethodLabel') : undefined}
        method={c.payment_method ? t(PAYMENT_METHOD_KEY[c.payment_method] ?? '') : undefined}
      />

      <PaymentPlan
        rows={plan.rows.map((r) => ({ id: r.id, stage: r.stage, note: r.note, amount: r.amount, state: r.state }))}
        paidLabel={t('contract.card.paymentPlanPaid')}
        dueLabel={t('contract.card.paymentPlanDue')}
        laterLabel={t('contract.card.paymentPlanLater')}
        payLabel={viewerRole === 'customer' ? t('contract.card.paymentPlanPay') : undefined}
        onPay={viewerRole === 'customer' ? (stageId) => navigate(`/contracts/${id}/payments/new?stage=${stageId}`) : undefined}
      />

      <PaymentPolicyLine
        title={t(c.payment_policy.transferFee.labelKey)}
        note={t(c.payment_policy.transferFee.noteKey)}
        positive={!c.payment_policy.transferFee.platformTakesCommission}
      />

      {/* Финмодель v2: комиссии за заключение нет ни для одного сегмента — plan.commission всегда undefined. */}
      <PaymentPolicyLine
        title={t(c.payment_policy.contractFee.labelKey)}
        note={t(c.payment_policy.contractFee.noteKey)}
        positive={!c.payment_policy.contractFee.applies}
      />
    </div>
  );
}

// ─────────────────────────────────────────── История
export function ContractHistoryTab(): JSX.Element {
  const { t } = useTranslation();
  const { formatDate, formatDateTime, formatMoney } = useFormatters();
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const { stub } = useCard();
  const { data: history, isPending } = useContractHistory(id);

  if (isPending || !history) {
    return (
      <div className={styles.tab}>
        <Skeleton width="100%" height={200} radius="var(--pr-r-lg)" />
      </div>
    );
  }

  /** Допник идёт по той же FSM согласования (NegotiationStatus), что и договор — сводим к 3 бакетам показа. */
  function amendmentBucket(status: NegotiationStatus): 'open' | 'accepted' | 'rejected' {
    if (status === 'signed') return 'accepted';
    if (status === 'rejected_by_counterparty' || status === 'withdrawn_by_initiator') return 'rejected';
    return 'open';
  }
  const AMENDMENT_STATUS_LABEL: Record<'open' | 'accepted' | 'rejected', string> = {
    open: t('contract.card.amendmentStatusOpen'),
    accepted: t('contract.card.amendmentStatusAccepted'),
    rejected: t('contract.card.amendmentStatusRejected'),
  };

  return (
    <div className={styles.tab}>
      <ContractTimeline
        events={history.events.map((e) => ({ id: e.id, title: e.text, at: formatDateTime(e.at), done: true }))}
      />

      <AmendmentsBlock
        amendments={history.amendments.map((a) => {
          const bucket = amendmentBucket(a.status);
          return {
            id: a.id,
            title: a.title,
            statusLabel: AMENDMENT_STATUS_LABEL[bucket],
            statusTone: bucket === 'accepted' ? 'green' : bucket === 'rejected' ? 'red' : 'amber',
            amountDeltaLabel: a.amount_delta ? formatMoney(a.amount_delta) : undefined,
            createdAtLabel: formatDate(a.created_at),
          };
        })}
        // Строка допника ведёт на его экран (`/contracts/{id}/amendments/{aid}`),
        // а не остаётся в «Истории» (бэклог 25.08, волна 4).
        onOpen={(amendmentId) => navigate(`/contracts/${id}/amendments/${amendmentId}`)}
        emptyTitle={t('contract.card.amendmentsEmptyTitle')}
        emptyText={t('contract.card.amendmentsEmptyText')}
        createLabel={t('contract.card.amendmentsCreate')}
        onCreate={() => stub('create-amendment')}
      />
    </div>
  );
}
