import { useEffect, useState } from 'react';
import { Navigate, useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import {
  ApiError,
  type ContractDetail,
  type CurrencyPolicy,
  type MoneyLike,
  type PartyDetails,
  type RevisionAuthorRole,
  type RevisionStatus,
} from '@porukam/core';
import {
  AcceptAllModal,
  Button,
  Callout,
  ContractTimeline,
  CounterSheet,
  DisputesPanel,
  ErrorState,
  FreezeCta,
  PreapprovedBlock,
  ProposeSheet,
  RejectSheet,
  ReviewDocument,
  ReviewHeader,
  RevisionCard,
  Skeleton,
  type AcceptAllChange,
  type BadgeTone,
  type RevisionSheetSubmitInput,
} from '@porukam/ui';
import { useContract, useContractApi, useTimeline } from '../features/contracts/api';
import { isRealContractId } from '../features/contracts/realDispatch';
import { useViewerStore } from '../features/contracts/viewerStore';
import { useFormatters } from '../shared/formatters';
import styles from './ContractReviewPage.module.css';
import { isFeatureEnabled } from '../shared/features';

const REVISION_STATUS_META: Record<RevisionStatus, { key: string; tone: BadgeTone }> = {
  open: { key: 'review.statusOpen', tone: 'amber' },
  accepted: { key: 'review.statusAccepted', tone: 'green' },
  rejected: { key: 'review.statusRejected', tone: 'neutral' },
  countered: { key: 'review.statusCountered', tone: 'neutral' },
  withdrawn: { key: 'review.statusWithdrawn', tone: 'neutral' },
};

function essenceText(
  c: ContractDetail,
  t: TFunction,
  formatPolicyMoney: (m: MoneyLike, currency: CurrencyPolicy) => string,
): string {
  const count = c.milestones.filter((m) => m.kind === 'leaf').length;
  return t('review.essenceLine', {
    title: c.title || c.sphere,
    sphere: c.sphere,
    count,
    sum: formatPolicyMoney(c.total, c.payment_policy.currency),
  });
}

function stageRows(
  c: ContractDetail,
  t: TFunction,
  proposable: boolean,
  formatPolicyMoney: (m: MoneyLike, currency: CurrencyPolicy) => string,
) {
  return c.milestones
    .filter((m) => m.kind === 'leaf')
    .map((m, i) => ({
      id: m.id,
      itemRef: `milestone:${m.id}:amount`,
      label: t('review.stageAmountItemLabel', { n: i + 1, title: m.title }),
      amountLabel: m.amount ? formatPolicyMoney(m.amount, c.payment_policy.currency) : '—',
      proposable,
    }));
}

function termRows(c: ContractDetail, t: TFunction, proposable: boolean) {
  if (!c.terms) return [];
  const terms = c.terms;
  return [
    {
      itemRef: 'term:warranty',
      label: t('review.termWarranty'),
      value: terms.warranty_months ? t('review.warrantyMonths', { count: terms.warranty_months }) : t('review.warrantyNone'),
      proposable,
    },
    {
      itemRef: 'term:acceptance_window',
      label: t('review.termAcceptanceWindow'),
      value: t('review.acceptanceWindowDays', { count: terms.acceptance_window_days }),
      proposable,
    },
    {
      itemRef: 'term:subcontract',
      label: t('review.termSubcontract'),
      value: t(`review.subcontract${terms.subcontract === 'forbidden' ? 'Forbidden' : terms.subcontract === 'allowed' ? 'Allowed' : 'WithConsent'}`),
      proposable,
    },
    {
      itemRef: 'term:premises_access',
      label: t('review.termPremisesAccess'),
      value: terms.premises_access ? t('review.yes') : t('review.no'),
      proposable,
    },
    {
      itemRef: 'term:portfolio_consent',
      label: t('review.termPortfolioConsent'),
      value: terms.portfolio_consent ? t('review.yes') : t('review.no'),
      proposable,
    },
  ];
}

function requisitesText(c: ContractDetail, t: TFunction): string | undefined {
  const pd = c.party_details;
  if (!pd) return undefined;
  const parts: string[] = [];
  (Object.keys(pd) as RevisionAuthorRole[]).forEach((role) => {
    const d: PartyDetails | undefined = pd[role];
    if (!d?.open) return;
    const values = Object.values(d.fields).filter(Boolean);
    if (values.length === 0) return;
    const roleLabel = t(role === 'customer' ? 'contract.roleCustomer' : 'contract.roleContractor');
    parts.push(`${roleLabel}: ${values.join(', ')}`);
  });
  return parts.length > 0 ? parts.join(' · ') : undefined;
}

interface ProposeCtx {
  itemRef: string;
  itemLabel: string;
  beforeValue: string;
}
interface RevisionCtx {
  revId: string;
  itemLabel: string;
}

/** DEV-10 · Согласование — протокол разногласий — `/contracts/:id/review`. */
export function ContractReviewPage(): JSX.Element {
  const { id: routeId = '' } = useParams();
  // Тот же рубеж, что у ContractPage (ADR-088): экран построен на мок-агрегате
  // ContractDetail (milestones/revisions/preapproved_alternatives), которых
  // реальный `/contracts/{id}` не отдаёт, — `c.revisions.filter` ронял экран
  // «Cannot read properties of undefined (reading 'filter')» (отсмотр
  // 2026-08-25, белый экран по ссылке из уведомления). Протокол разногласий
  // реального контура живёт вкладкой «Переговоры и подписи» карточки.
  if (isRealContractId(routeId)) return <Navigate to={`/contracts/${routeId}`} replace />;
  return <LegacyContractReviewPage />;
}

function LegacyContractReviewPage(): JSX.Element {
  const { t } = useTranslation();
  const { formatDateTime, formatPolicyMoney } = useFormatters();
  const navigate = useNavigate();
  const { id = '' } = useParams();
  const { data: c, isPending, error, refetch } = useContract(id);
  const { data: timeline } = useTimeline(id);
  const api = useContractApi(id);
  const viewAs = useViewerStore((s) => s.viewAs);

  const [err, setErr] = useState<string | null>(null);
  const [proposeCtx, setProposeCtx] = useState<ProposeCtx | null>(null);
  const [counterCtx, setCounterCtx] = useState<RevisionCtx | null>(null);
  const [rejectCtx, setRejectCtx] = useState<RevisionCtx | null>(null);
  const [acceptAllData, setAcceptAllData] = useState<{ changes: AcceptAllChange[]; totalBefore: string; totalAfter: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!c) return;
    if (c.status === 'pending_signature' || c.status === 'awaiting_signatures' || c.status === 'signed') {
      navigate(`/contracts/${id}/sign`, { replace: true });
    } else if (c.status === 'draft') {
      navigate(`/contracts/${id}`, { replace: true });
    }
  }, [c?.status, id, navigate]);

  if (isPending || !c) {
    return (
      <div className={styles.wrap}>
        <Skeleton width="60%" height={32} />
        <Skeleton width="100%" height={120} radius="var(--pr-r-lg)" />
        <Skeleton width="100%" height={200} radius="var(--pr-r-lg)" />
      </div>
    );
  }

  if (error) {
    const code = error instanceof ApiError ? error.code : undefined;
    // Чужое приватное = 404 (не «нет доступа») — приватность не раскрывает существование объекта.
    if (code === 'not_found') {
      return (
        <div className={styles.wrap}>
          <ErrorState title={t('review.notFoundTitle')} />
          <p className={styles.notFoundText}>{t('review.notFoundText')}</p>
        </div>
      );
    }
    return (
      <div className={styles.wrap}>
        <ErrorState title={t('review.errorText')} code={code} retryLabel={t('common.retry')} onRetry={() => void refetch()} />
      </div>
    );
  }

  function friendlyError(e: unknown): string {
    if (e instanceof ApiError) {
      if (e.code === 'revision_closed') return t('review.errRevisionClosed');
      if (e.code === 'not_initiator') return t('review.errNotInitiator');
      return e.message;
    }
    return String(e);
  }

  async function guarded(fn: () => Promise<unknown>): Promise<void> {
    setErr(null);
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      setErr(friendlyError(e));
    } finally {
      setBusy(false);
    }
  }

  // ── Терминальные выходы (§8) — без влияния на репутацию, спокойное подтверждение. ──
  if (c.status === 'withdrawn_by_initiator' || c.status === 'rejected_by_counterparty') {
    return (
      <div className={styles.wrap}>
        <div className={styles.terminal}>
          <h1>{t(c.status === 'withdrawn_by_initiator' ? 'review.terminalWithdrawnTitle' : 'review.terminalRejectedTitle')}</h1>
          <p className={styles.notFoundText}>{t('review.terminalNote')}</p>
        </div>
      </div>
    );
  }

  const openRevisions = c.revisions.filter((r) => r.status === 'open');
  const yourTurn = openRevisions.filter((r) => r.author_role !== viewAs);
  const acceptAllEligible =
    openRevisions.filter((r) => r.variants.length === 1).length + c.preapproved_alternatives.filter((a) => a.variants.length === 1).length;

  async function pick(revId: string, variantId: string): Promise<void> {
    await guarded(() => api.post(`/revisions/${revId}/accept`, { variant_id: variantId }));
  }
  async function withdrawRevision(revId: string): Promise<void> {
    await guarded(() => api.post(`/revisions/${revId}/withdraw`));
  }
  async function applyPreapproved(altId: string, variantId: string): Promise<void> {
    await guarded(() => api.post(`/preapproved-alternatives/${altId}/apply`, { variant_id: variantId }));
  }

  async function submitPropose(input: RevisionSheetSubmitInput): Promise<void> {
    if (!proposeCtx) return;
    await guarded(() =>
      api.post('/revisions', {
        item_ref: proposeCtx.itemRef,
        item_label: proposeCtx.itemLabel,
        before: proposeCtx.beforeValue,
        variants: input.variants,
        comment: input.comment,
        // Финансово значимая — деньги/сумма этапа (§8.5); термины/условия — нет.
        financially_material: proposeCtx.itemRef.includes(':amount'),
      }),
    );
    setProposeCtx(null);
  }

  async function submitCounter(input: RevisionSheetSubmitInput): Promise<void> {
    if (!counterCtx) return;
    await guarded(() => api.post(`/revisions/${counterCtx.revId}/counter`, { variants: input.variants, comment: input.comment }));
    setCounterCtx(null);
  }

  async function submitReject(comment?: string): Promise<void> {
    if (!rejectCtx) return;
    await guarded(() => api.post(`/revisions/${rejectCtx.revId}/reject`, { comment }));
    setRejectCtx(null);
  }

  async function acceptAll(confirmSummary: boolean): Promise<void> {
    setErr(null);
    setBusy(true);
    try {
      await api.post('/revisions/accept-all', { confirm_summary: confirmSummary });
      setAcceptAllData(null);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'confirm_summary_required') {
        const p = e.problem as {
          changes?: { id: string; item_label: string; before: string; after: string }[];
          total_before?: MoneyLike;
          total_after?: MoneyLike;
        };
        setAcceptAllData({
          changes: (p.changes ?? []).map((ch) => ({ id: ch.id, itemLabel: ch.item_label, fromValue: ch.before, toValue: ch.after })),
          totalBefore: p.total_before ? formatPolicyMoney(p.total_before, c!.payment_policy.currency) : '',
          totalAfter: p.total_after ? formatPolicyMoney(p.total_after, c!.payment_policy.currency) : '',
        });
      } else {
        setErr(friendlyError(e));
      }
    } finally {
      setBusy(false);
    }
  }

  async function freeze(): Promise<void> {
    setErr(null);
    setBusy(true);
    try {
      await api.post('/freeze');
      navigate(`/contracts/${id}/sign`);
    } catch (e) {
      if (e instanceof ApiError) {
        if (e.code === 'requisites_missing') setErr(t('contract.errRequisites'));
        else if (e.code === 'open_revisions') setErr(t('contract.errOpenRevisions'));
        else if (e.code === 'leaf_sum_mismatch') setErr(t('contract.errLeafMismatch'));
        else setErr(e.message);
      } else setErr(String(e));
    } finally {
      setBusy(false);
    }
  }

  const counterparty = c.parties.find((p) => p.role !== viewAs);
  const requisites = requisitesText(c, t);

  return (
    <div className={styles.wrap}>
      <ReviewHeader
        title={c.title}
        statusLabel={t('contract.statusUnderReview')}
        counterpartyName={counterparty?.display_name ?? ''}
        viewerRoleLabel={t(viewAs === 'customer' ? 'review.viewerRoleCustomer' : 'review.viewerRoleContractor')}
        openCountLabel={t('review.openCount', { count: openRevisions.length })}
        yourTurnCount={yourTurn.length}
        yourTurnLabel={yourTurn.length > 0 ? t('review.yourTurn', { count: yourTurn.length }) : undefined}
        menuLabel={t('review.menuLabel')}
        onWithdraw={viewAs === c.initiator_role ? () => void guarded(() => api.post('/withdraw')) : undefined}
        withdrawLabel={t('review.withdraw')}
        onRejectContract={viewAs !== c.initiator_role ? () => void guarded(() => api.post('/reject')) : undefined}
        rejectLabel={t('review.rejectContract')}
        onChat={isFeatureEnabled('chat') ? () => navigate('/chat') : undefined}
        chatLabel={t('review.chatCta')}
      />

      {err ? <Callout tone="warn">{err}</Callout> : null}

      <div className={styles.layout}>
        <div className={styles.main}>
          <ReviewDocument
            sectionTitles={{
              parties: t('review.sectionParties'),
              essence: t('review.sectionEssence'),
              stages: t('review.sectionStages'),
              terms: t('review.sectionTerms'),
              requisites: t('review.sectionRequisites'),
            }}
            parties={c.parties.map((p) => ({
              id: p.profile_id,
              name: p.display_name,
              roleLabel: t(p.role === 'customer' ? 'contract.roleCustomer' : 'contract.roleContractor'),
              handle: p.handle,
            }))}
            essenceText={essenceText(c, t, formatPolicyMoney)}
            stages={stageRows(c, t, c.status === 'under_review', formatPolicyMoney)}
            stagesSumLabel={t('review.stagesSum')}
            stagesSum={formatPolicyMoney(c.total, c.payment_policy.currency)}
            terms={termRows(c, t, c.status === 'under_review')}
            requisitesText={requisites}
            proposeLabel={t('review.proposeChange')}
            onPropose={(itemRef, itemLabel, beforeValue) => setProposeCtx({ itemRef, itemLabel, beforeValue })}
          />

          {c.preapproved_alternatives.length > 0 ? (
            <PreapprovedBlock
              title={t('review.preapprovedTitle')}
              pickLabel={t('review.applyInOneClick')}
              onApply={(altId, variantId) => void applyPreapproved(altId, variantId)}
              items={c.preapproved_alternatives.map((a) => ({
                id: a.id,
                itemLabel: a.item_label,
                ariaLabel: t('review.variantPickerAriaLabel', { item: a.item_label }),
                fromLabel: t('review.fromLabel'),
                fromValue: a.before,
                variants: a.variants.map((v) => ({ id: v.id, label: v.value, note: v.note })),
              }))}
            />
          ) : null}

          {c.revisions.length > 0 ? (
            <>
              {(openRevisions.length > 0 || acceptAllEligible > 0) && (
                <div className={styles.acceptAllRow}>
                  <Button variant="secondary" onClick={() => void acceptAll(false)} disabled={acceptAllEligible === 0 || busy} data-testid="accept-all">
                    {t('review.acceptAll')}
                  </Button>
                </div>
              )}
              {c.revisions.map((r) => {
                const isMine = r.author_role === viewAs;
                const meta = REVISION_STATUS_META[r.status];
                return (
                  <div key={r.id} id={`revision-${r.id}`}>
                    <RevisionCard
                      itemLabel={r.item_label}
                      fromLabel={t('review.fromLabel')}
                      fromValue={r.before}
                      variants={r.variants.map((v) => ({ id: v.id, label: v.value, note: v.note }))}
                      ariaLabel={t('review.variantPickerAriaLabel', { item: r.item_label })}
                      pickLabel={t('review.pick')}
                      statusLabel={t(meta.key)}
                      statusTone={meta.tone}
                      financiallyMaterialLabel={r.financially_material ? t('review.financiallyMaterial') : undefined}
                      comment={r.comment || undefined}
                      isMine={isMine}
                      open={r.status === 'open'}
                      chosenVariantId={r.chosen_variant_id ?? null}
                      onPick={(variantId) => void pick(r.id, variantId)}
                      rejectLabel={t('review.reject')}
                      onReject={() => setRejectCtx({ revId: r.id, itemLabel: r.item_label })}
                      counterLabel={t('review.counter')}
                      onCounter={() => setCounterCtx({ revId: r.id, itemLabel: r.item_label })}
                      withdrawLabel={t('review.withdrawRevision')}
                      onWithdraw={() => void withdrawRevision(r.id)}
                      waitingLabel={t('review.waitingCounterparty')}
                    />
                  </div>
                );
              })}
            </>
          ) : null}

          <FreezeCta
            active={openRevisions.length === 0}
            label={t('review.freeze')}
            hint={t('review.freezeHint')}
            blockedHint={t('review.freezeBlockedHint')}
            onFreeze={() => void freeze()}
            loading={busy}
          />

          {timeline && timeline.length > 0 ? (
            <ContractTimeline events={timeline.map((e) => ({ id: e.id, title: e.text, at: formatDateTime(e.at), done: true }))} />
          ) : null}
        </div>

        <div className={styles.sidebar}>
          <DisputesPanel
            title={t('review.disputesTitle')}
            emptyTitle={t('review.disputesEmpty')}
            items={openRevisions.map((r) => ({
              id: r.id,
              itemLabel: r.item_label,
              statusLabel: t(REVISION_STATUS_META[r.status].key),
              statusTone: REVISION_STATUS_META[r.status].tone,
              turnLabel: t(r.author_role === viewAs ? 'review.counterpartyTurnBadge' : 'review.yourTurnBadge'),
            }))}
            onOpen={(revId) => document.getElementById(`revision-${revId}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })}
          />
        </div>
      </div>

      {proposeCtx ? (
        <ProposeSheet
          open={!!proposeCtx}
          title={t('review.proposeTitle')}
          itemLabel={proposeCtx.itemLabel}
          onClose={() => setProposeCtx(null)}
          onSubmit={(input) => void submitPropose(input)}
          closeLabel={t('common.close')}
          cancelLabel={t('common.cancel')}
          submitLabel={t('review.submitPropose')}
          variantValueLabel={t('review.variantValueLabel')}
          variantNoteLabel={t('review.variantNoteLabel')}
          addVariantLabel={t('review.addVariant')}
          removeVariantLabel={t('review.removeVariant')}
          commentLabel={t('review.commentLabel')}
          variantRequiredHint={t('review.variantRequired')}
          submitting={busy}
        />
      ) : null}

      {counterCtx ? (
        <CounterSheet
          open={!!counterCtx}
          title={t('review.counterTitle')}
          itemLabel={counterCtx.itemLabel}
          onClose={() => setCounterCtx(null)}
          onSubmit={(input) => void submitCounter(input)}
          closeLabel={t('common.close')}
          cancelLabel={t('common.cancel')}
          submitLabel={t('review.submitCounter')}
          variantValueLabel={t('review.variantValueLabel')}
          variantNoteLabel={t('review.variantNoteLabel')}
          addVariantLabel={t('review.addVariant')}
          removeVariantLabel={t('review.removeVariant')}
          commentLabel={t('review.commentLabel')}
          variantRequiredHint={t('review.variantRequired')}
          submitting={busy}
        />
      ) : null}

      {rejectCtx ? (
        <RejectSheet
          open={!!rejectCtx}
          title={t('review.rejectTitle')}
          itemLabel={rejectCtx.itemLabel}
          onClose={() => setRejectCtx(null)}
          onReject={(comment) => void submitReject(comment)}
          onProposeCounter={() => {
            setCounterCtx({ revId: rejectCtx.revId, itemLabel: rejectCtx.itemLabel });
            setRejectCtx(null);
          }}
          closeLabel={t('common.close')}
          cancelLabel={t('common.cancel')}
          rejectLabel={t('review.rejectSubmit')}
          commentLabel={t('review.rejectComment')}
          counterHintTitle={t('review.counterHintTitle')}
          counterHintCta={t('review.counterHintCta')}
          submitting={busy}
        />
      ) : null}

      {acceptAllData ? (
        <AcceptAllModal
          open={!!acceptAllData}
          title={t('review.acceptAllTitle')}
          text={t('review.acceptAllText')}
          onClose={() => setAcceptAllData(null)}
          closeLabel={t('common.close')}
          cancelLabel={t('common.cancel')}
          confirmLabel={t('review.confirmAcceptAll')}
          onConfirm={() => void acceptAll(true)}
          submitting={busy}
          changes={acceptAllData.changes}
          totalBeforeLabel={t('review.totalBefore')}
          totalBefore={acceptAllData.totalBefore}
          totalAfterLabel={t('review.totalAfter')}
          totalAfter={acceptAllData.totalAfter}
          excludedHint={c.revisions.some((r) => r.status === 'open' && r.variants.length > 1) ? t('review.acceptAllExcludedHint') : undefined}
        />
      ) : null}
    </div>
  );
}
