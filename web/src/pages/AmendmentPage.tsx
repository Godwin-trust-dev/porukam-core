import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  ApiError,
  Money,
  type ContractRole,
  type MoneyLike,
  type NegotiationStatus,
  type RealAmendmentChange,
  type RealAmendmentChangeType,
  type RealMilestoneTreeNode,
  type RealSignatureRequest,
} from '@porukam/core';
import {
  Badge,
  Button,
  Callout,
  Ceremony,
  ErrorState,
  FrozenVersion,
  Logo,
  LtrText,
  Modal,
  SignResult,
  SignatureRow,
  Skeleton,
  TextArea,
  TextField,
  type BadgeTone,
  type SignatureRowState,
} from '@porukam/ui';
import { useActorStore } from '../features/actor/actorStore';
import { useCurrentUser } from '../features/auth/useAuth';
import { useRealContract, useRealContractMilestones } from '../features/contracts/realApi';
import { timelineKind, timelineTitle } from '../features/contracts/timelineView';
import { useContractVersion } from '../features/contracts/realSigningApi';
import {
  useAmendment,
  useAmendmentSignatories,
  useAmendmentSignatureRequests,
  useAmendmentTimeline,
  useCreateAmendmentSignatureRequest,
  useDeclineAmendmentSignatureRequest,
  useDeleteAmendment,
  useEffectiveTerms,
  useFreezeAmendment,
  useRejectAmendment,
  useSendAmendment,
  useSignAmendmentSignatureRequest,
  useUpdateAmendment,
  useWithdrawAmendment,
} from '../features/contracts/realAmendmentsApi';
import { RealAmendmentFormModal } from '../features/contracts/RealAmendmentFormModal';
import { useFormatters } from '../shared/formatters';
import { apiErrorText } from '../shared/apiErrorText';
import styles from './AmendmentPage.module.css';

/** Допник идёт по ТОЙ ЖЕ FSM согласования, что договор (`NegotiationStatus`),
 * поэтому подписи статусов — общие с карточкой договора (`contract.card.*`). */
const STATUS_KEY: Record<NegotiationStatus, string> = {
  draft: 'contract.card.statusDraft',
  under_review: 'contract.card.statusUnderReview',
  rejected_by_counterparty: 'contract.card.statusRejectedByCounterparty',
  withdrawn_by_initiator: 'contract.card.statusWithdrawnByInitiator',
  pending_signature: 'contract.card.statusPendingSignature',
  awaiting_signatures: 'contract.card.statusAwaitingSignatures',
  signed: 'contract.card.statusSigned',
};

const STATUS_TONE: Record<NegotiationStatus, BadgeTone> = {
  draft: 'neutral',
  under_review: 'amber',
  rejected_by_counterparty: 'red',
  withdrawn_by_initiator: 'red',
  pending_signature: 'teal',
  awaiting_signatures: 'amber',
  signed: 'green',
};

const CHANGE_KEY: Record<RealAmendmentChangeType, string> = {
  add_milestone: 'contract.amendment.changeAddMilestone',
  modify_milestone: 'contract.amendment.changeModifyMilestone',
  remove_milestone: 'contract.amendment.changeRemoveMilestone',
  add_material: 'contract.amendment.changeAddMaterial',
  modify_material: 'contract.amendment.changeModifyMaterial',
  remove_material: 'contract.amendment.changeRemoveMaterial',
  custom_term: 'contract.amendment.changeCustomTerm',
};

/** Статусы, из которых допник можно отозвать (инициатор) или отклонить
 * (вторая сторона) — общая `NEGOTIATION_FSM` договора: `withdraw`/`reject`
 * объявлены из `under_review` и из замороженных состояний. */
const CLOSABLE: NegotiationStatus[] = ['under_review', 'pending_signature', 'awaiting_signatures'];

/** Причина отклонения/отзыва живёт в payload события (`reason`), у самого
 * допника такого поля нет — фолбэк для `detail` строки хроники, когда бэк
 * `detail` не прислал (ADR-134: подписи с бэка, причина — из payload). */
function eventReason(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const reason = (payload as { reason?: unknown; comment?: unknown }).reason ?? (payload as { comment?: unknown }).comment;
  return typeof reason === 'string' && reason.trim() ? reason : undefined;
}

/** Самая свежая заявка на сторону — список приходит `-sent_at` (реальный
 * бэк и мок одинаково), первое совпадение и есть текущее состояние стороны. */
function latestRequestForSide(requests: RealSignatureRequest[], side: ContractRole | undefined): RealSignatureRequest | undefined {
  return side ? requests.find((r) => r.side === side) : undefined;
}

function flattenTree(nodes: RealMilestoneTreeNode[], out: RealMilestoneTreeNode[] = []): RealMilestoneTreeNode[] {
  for (const n of nodes) {
    out.push(n);
    flattenTree(n.children, out);
  }
  return out;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v : undefined;
}

interface DiffRow {
  label: string;
  was?: string;
  becomes?: string;
}

/**
 * Экран допсоглашения (Amendment) — `/contracts/:id/amendments/:amendmentId`
 * (бэклог 25.08, волна 4: «маршрутов амендментов во фронте нет»). Э4.5
 * бэкенда, tech-spec.md §8.6; скидка по спору — тоже допник, «принятие =
 * подпись» (ADR-131 §3).
 *
 * Что показываем: причина, изменения «было → станет» (цель — из живого
 * дерева этапов, новое значение — из payload изменения, дельты — серверные),
 * итог по сумме договора, замороженная версия (hash), подписи сторон,
 * хроника `amendment.*`. Действия — ровно те, что даёт бэк: «Отправить»
 * (draft), «Подписать» одной кнопкой (заморозка → заявка → подпись на
 * `integrity_hash`, как на SigningPage), «Вернуть на доработку» — адресату
 * pending-заявки (`signature-requests/{id}/decline`), «Отозвать» —
 * инициатору (`/amendments/{id}/withdraw`), «Отклонить» — второй стороне
 * (`/amendments/{id}/reject`); оба — с подтверждением и необязательной
 * причиной, оба терминальны (общая `NEGOTIATION_FSM`). Скидка по спору,
 * отклонённая или отозванная, возвращает разногласие в `open` — подписчиком
 * бэка, карточка спора это просто перечитывает.
 */
export function AmendmentPage(): JSX.Element {
  const { id = '', amendmentId = '' } = useParams();
  const { t } = useTranslation();
  const { formatDate, formatDateTime, formatMoney } = useFormatters();
  const navigate = useNavigate();

  const amendmentQ = useAmendment(amendmentId);
  const contractQ = useRealContract(id);
  const milestonesQ = useRealContractMilestones(id);
  const sigReqsQ = useAmendmentSignatureRequests(amendmentId);
  const timelineQ = useAmendmentTimeline(amendmentId);
  const meQ = useCurrentUser();

  const amendment = amendmentQ.data;
  const contract = contractQ.data;
  const status = amendment?.negotiation_status;
  const isSigned = status === 'signed';
  // Действующая редакция — только у подписанного допника (его дельта уже
  // применена к дереву, «стало» — живая сумма по листьям).
  const effectiveQ = useEffectiveTerms(id, isSigned);
  const versionQ = useContractVersion(id, amendment?.frozen_version_id ?? undefined);

  const myProfileId = useActorStore((s) => s.activeProfileId);
  const myParty = contract?.parties.find((p) => p.profile_id === myProfileId);
  const myRole = myParty?.role;
  const signatoriesQ = useAmendmentSignatories(amendmentId, myRole);

  const send = useSendAmendment(amendmentId, id);
  const freeze = useFreezeAmendment(amendmentId, id);
  const createSignatureRequest = useCreateAmendmentSignatureRequest(amendmentId, id);
  const sign = useSignAmendmentSignatureRequest(amendmentId, id);
  const decline = useDeclineAmendmentSignatureRequest(amendmentId, id);
  const withdraw = useWithdrawAmendment(amendmentId, id);
  const reject = useRejectAmendment(amendmentId, id);
  // ADR-161 §2: правка и удаление ЧЕРНОВИКА — только у его инициатора.
  const update = useUpdateAmendment(amendmentId, id);
  const remove = useDeleteAmendment(amendmentId, id);

  const [err, setErr] = useState<string | null>(null);
  const [signing, setSigning] = useState(false);
  const [noSignatory, setNoSignatory] = useState(false);
  const [justSignedAt, setJustSignedAt] = useState<string | undefined>();
  const [ceremonyOpen, setCeremonyOpen] = useState(false);
  const [returnOpen, setReturnOpen] = useState(false);
  const [returnComment, setReturnComment] = useState('');
  const [closeKind, setCloseKind] = useState<'reject' | 'withdraw' | null>(null);
  const [closeReason, setCloseReason] = useState('');
  const [editOpen, setEditOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  // Стабильный `onClose`: эффект `Modal` зависит от него и при новой функции
  // на каждый рендер возвращал бы фокус на диалог после каждого символа в
  // поле причины.
  const closeCloseModal = useCallback(() => setCloseKind(null), []);
  const wasSignedRef = useRef<boolean | null>(null);

  useEffect(() => {
    if (!status) return;
    const nowSigned = status === 'signed';
    if (wasSignedRef.current === false && nowSigned) setCeremonyOpen(true);
    wasSignedRef.current = nowSigned;
  }, [status]);

  if (amendmentQ.isPending || contractQ.isPending) {
    return (
      <div className={styles.wrap}>
        <Skeleton width="60%" height={30} />
        <Skeleton width="100%" height={120} radius="var(--pr-r-lg)" />
        <Skeleton width="100%" height={200} radius="var(--pr-r-lg)" />
      </div>
    );
  }
  const loadError = amendmentQ.error ?? contractQ.error;
  if (loadError || !amendment || !contract) {
    return (
      <div className={styles.wrap}>
        <ErrorState
          title={t('contract.amendment.errorText')}
          text={apiErrorText(loadError)}
          code={loadError instanceof ApiError ? loadError.code : undefined}
          retryLabel={t('common.retry')}
          onRetry={() => {
            void amendmentQ.refetch();
            void contractQ.refetch();
          }}
        />
      </div>
    );
  }

  const sigReqs = sigReqsQ.data ?? [];
  const mySigReq = latestRequestForSide(sigReqs, myRole);
  const mySigned = mySigReq?.status === 'signed';
  const version = amendment.frozen_version_id ? versionQ.data : undefined;
  const hashShort = version ? `${version.integrity_hash.slice(0, 18)}…` : '';
  const milestones = flattenTree(milestonesQ.data ?? []);

  function describeError(e: unknown): string {
    if (e instanceof ApiError) {
      if (e.code === 'version_stale') return t('contract.amendment.errVersionStale');
      if (e.code === 'amendment_targets_accepted') return t('contract.amendment.errTargetsAccepted');
      if (e.code === 'not_initiator') return t('contract.amendment.errNotInitiator');
      if (e.code === 'not_counterparty') return t('contract.amendment.errNotCounterparty');
      if (e.code === 'invalid_negotiation_transition' || e.code === 'invalid_transition') return t('contract.amendment.errInvalidTransition');
      if (e.code === 'amendment_not_draft') return t('contract.amendment.errNotDraft');
      return e.code ? `${e.message} (${e.code})` : e.message;
    }
    return String(e);
  }

  async function run(fn: () => Promise<unknown>): Promise<boolean> {
    setErr(null);
    try {
      await fn();
      return true;
    } catch (e) {
      setErr(describeError(e));
      return false;
    }
  }

  /** «Подписать» одним нажатием — та же цепочка, что у договора (решение
   * 2026-08-25): под согласованием сначала заморозка версии допника, затем
   * заявка на подпись своей стороны, если её ещё нет, затем подпись на
   * `integrity_hash` ТЕКУЩЕЙ версии (инвариант CLAUDE.md). */
  async function onSign(): Promise<void> {
    if (!myRole || !amendment || signing) return;
    setNoSignatory(false);
    setSigning(true);
    try {
      await run(async () => {
        let versionId = amendment.frozen_version_id ?? undefined;
        let versionHash = versionQ.data?.integrity_hash;
        if (amendment.negotiation_status === 'under_review') {
          const frozen = await freeze.mutateAsync();
          versionId = frozen.id;
          versionHash = frozen.integrity_hash;
        }
        if (!versionId || !versionHash) return;

        let request = mySigReq?.status === 'pending' && mySigReq.version_id === versionId ? mySigReq : undefined;
        if (!request) {
          const options = signatoriesQ.data ?? (await signatoriesQ.refetch()).data;
          const option = options?.[0];
          if (!option) {
            setNoSignatory(true);
            return;
          }
          request = await createSignatureRequest.mutateAsync({ side: myRole, version_id: versionId, signatory_user_id: option.user_id });
        }
        const signature = await sign.mutateAsync({ signatureRequestId: request.id, input: { version_hash: versionHash } });
        setJustSignedAt(signature.signed_at);
      });
    } finally {
      setSigning(false);
    }
  }

  async function onConfirmReturn(): Promise<void> {
    const comment = returnComment.trim();
    if (!comment || !mySigReq) return;
    const ok = await run(() => decline.mutateAsync({ signatureRequestId: mySigReq.id, input: { comment } }));
    setReturnOpen(false);
    if (ok) setReturnComment('');
  }

  /** Отклонить/отозвать — терминально: модалка с необязательной причиной,
   * чтобы «случайный тап» не закрыл согласование навсегда. */
  async function onConfirmClose(): Promise<void> {
    if (!closeKind) return;
    const input = closeReason.trim() ? { reason: closeReason.trim() } : {};
    const ok = await run(() => (closeKind === 'reject' ? reject.mutateAsync(input) : withdraw.mutateAsync(input)));
    setCloseKind(null);
    if (ok) setCloseReason('');
  }

  function rowState(sigReq: RealSignatureRequest | undefined, side: ContractRole): { state: SignatureRowState; signedAt?: string } {
    // Время подписи — из заявки (`signed_at`, если бэк его отдаёт), иначе
    // из только что поставленной своей подписи.
    if (sigReq?.status === 'signed') return { state: 'signed', signedAt: sigReq.signed_at ?? (side === myRole ? justSignedAt : undefined) };
    if (sigReq?.status === 'pending' && side === myRole) return { state: 'you' };
    return { state: 'waiting' };
  }

  // ── «Было / станет» по каждому изменению ──
  const money = (amount: unknown, currency: unknown): string | undefined =>
    typeof amount === 'string' && typeof currency === 'string' ? formatMoney({ amount, currency }) : undefined;
  const changeDelta = (ch: RealAmendmentChange): MoneyLike | null =>
    ch.amount_delta !== null && ch.amount_delta_currency !== null ? { amount: ch.amount_delta, currency: ch.amount_delta_currency } : null;

  function targetTitle(ch: RealAmendmentChange): string | undefined {
    if (!ch.target) return undefined;
    return milestones.find((m) => m.id === ch.target)?.title;
  }

  function diffRows(ch: RealAmendmentChange): DiffRow[] {
    const p = ch.payload;
    const rows: DiffRow[] = [];
    const target = milestones.find((m) => m.id === ch.target);
    const delta = changeDelta(ch);
    if (ch.type === 'add_milestone') {
      if (str(p.title)) rows.push({ label: t('contract.amendment.fieldTitle'), becomes: str(p.title) });
      if (money(p.amount, p.currency)) rows.push({ label: t('contract.amendment.fieldAmount'), becomes: money(p.amount, p.currency) });
      if (str(p.deadline)) rows.push({ label: t('contract.amendment.fieldDeadline'), becomes: formatDate(String(p.deadline), { legal: true }) });
    } else if (ch.type === 'modify_milestone') {
      if (str(p.title)) rows.push({ label: t('contract.amendment.fieldTitle'), was: isSigned ? undefined : target?.title, becomes: str(p.title) });
      const becomes = money(p.amount, p.currency);
      if (becomes) {
        // До применения «было» — живое значение листа; после — лист уже
        // изменён, восстанавливаем из серверной дельты (новое − дельта).
        let was: string | undefined;
        if (!isSigned && target?.amount && target.currency) was = formatMoney({ amount: target.amount, currency: target.currency });
        else if (isSigned && delta && typeof p.amount === 'string') {
          was = formatMoney(Money.of(p.amount, delta.currency).subtract(Money.from(delta)));
        }
        rows.push({ label: t('contract.amendment.fieldAmount'), was, becomes });
      }
      if (str(p.deadline)) {
        rows.push({
          label: t('contract.amendment.fieldDeadline'),
          was: !isSigned && target?.deadline ? formatDate(target.deadline, { legal: true }) : undefined,
          becomes: formatDate(String(p.deadline), { legal: true }),
        });
      }
    } else if (ch.type === 'remove_milestone') {
      if (delta) rows.push({ label: t('contract.amendment.fieldAmount'), was: formatMoney(Money.of('0.00', delta.currency).subtract(Money.from(delta))), becomes: formatMoney({ amount: '0.00', currency: delta.currency }) });
    } else if (ch.type === 'add_material' || ch.type === 'modify_material') {
      if (str(p.description)) rows.push({ label: t('contract.amendment.fieldTitle'), becomes: str(p.description) });
      if (str(p.quantity)) rows.push({ label: t('contract.amendment.fieldQuantity'), becomes: `${p.quantity}${str(p.unit) ? ` ${p.unit}` : ''}` });
      if (money(p.unit_price, p.unit_price_currency)) rows.push({ label: t('contract.amendment.fieldUnitPrice'), becomes: money(p.unit_price, p.unit_price_currency) });
    }
    return rows;
  }

  // ── Итог по сумме договора ──
  const totalDelta = amendment.amount_delta;
  const liveTotal = contract.total;
  let totalWas: MoneyLike | null = null;
  let totalBecomes: MoneyLike | null = null;
  if (totalDelta && liveTotal && liveTotal.currency === totalDelta.currency) {
    if (isSigned) {
      totalBecomes = effectiveQ.data?.total_amount ?? liveTotal;
      totalWas = Money.from(totalBecomes).subtract(Money.from(totalDelta)).toJSON();
    } else {
      totalWas = liveTotal;
      totalBecomes = Money.from(liveTotal).add(Money.from(totalDelta)).toJSON();
    }
  }

  const antiWaiver = amendment.changes.map((c) => str(c.payload.anti_waiver)).find(Boolean);
  const customerParty = contract.parties.find((p) => p.role === 'customer');
  const contractorParty = contract.parties.find((p) => p.role === 'contractor');
  const closed = status === 'rejected_by_counterparty' || status === 'withdrawn_by_initiator';
  const actionable = !!myRole && !isSigned && !closed && status !== 'draft' && !mySigned;
  const anyPending = signing || send.isPending || freeze.isPending || createSignatureRequest.isPending || sign.isPending || decline.isPending || withdraw.isPending || reject.isPending || update.isPending || remove.isPending;
  const signatoryKnownEmpty = (signatoriesQ.data?.length ?? -1) === 0 && mySigReq?.status !== 'pending';
  const signBlocked = (mySigReq?.status === 'pending' && !!meQ.data && mySigReq.signatory_id !== meQ.data.id) || signatoryKnownEmpty;
  const canReturn = mySigReq?.status === 'pending' && status === 'awaiting_signatures' && !!meQ.data && mySigReq.signatory_id === meQ.data.id;
  // Инициатор — по `created_by_id` (id ПОЛЬЗОВАТЕЛЯ, не профиля — как у
  // `withdraw_negotiation`); без `users/me` роль неизвестна — обе кнопки
  // прячем, последнее слово всё равно за бэком (403 not_initiator/not_counterparty).
  const isInitiator = !!meQ.data && amendment.created_by_id === meQ.data.id;
  const closable = !!myRole && !!meQ.data && !!status && CLOSABLE.includes(status);
  const canWithdraw = closable && isInitiator;
  const canReject = closable && !isInitiator && !mySigned;
  const timeline = timelineQ.data ?? [];

  return (
    <div className={styles.wrap}>
      <div className={styles.head}>
        <Button variant="ghost" size="sm" onClick={() => navigate(`/contracts/${id}`)} data-testid="amendment-back">
          {t('contract.amendment.backToContract')}
        </Button>
        <h1 className={styles.title} data-testid="amendment-title">{t('contract.amendment.title', { order: amendment.order })}</h1>
        <p className={styles.sub}>{t('contract.amendment.toContract', { title: contract.title || t('contracts.titleUnset') })}</p>
        <div className={styles.meta}>
          <span data-testid="amendment-status">
            <Badge tone={STATUS_TONE[amendment.negotiation_status]}>{t(STATUS_KEY[amendment.negotiation_status])}</Badge>
          </span>
          {myRole ? <Badge tone="ink">{t('signing.realSigningAs')}: {t(myRole === 'customer' ? 'contract.roleCustomer' : 'contract.roleContractor')}</Badge> : null}
          <span>{t('contract.amendment.createdAt', { date: formatDate(amendment.created_at, { legal: true }) })}</span>
          {version ? <Badge tone="teal">{t('signing.frozenBadge')}</Badge> : null}
        </div>
      </div>

      {err ? <div data-testid="amendment-error"><Callout tone="warn">{err}</Callout></div> : null}

      {status === 'draft' ? (
        <Callout tone="neutral" title={t('contract.amendment.draftTitle')}>{t('contract.amendment.draftText')}</Callout>
      ) : null}
      {closed ? (
        <Callout tone="neutral" title={t('contract.amendment.closedTitle')}>
          <span data-testid="amendment-closed-text">
            {t(status === 'rejected_by_counterparty' ? 'contract.amendment.closedRejectedText' : 'contract.amendment.closedWithdrawnText')}
          </span>
        </Callout>
      ) : null}

      <div className={styles.card}>
        <h3 className={styles.sectionTitle}>{t('contract.amendment.reasonTitle')}</h3>
        <p className={styles.bodyText} data-testid="amendment-reason">{amendment.reason}</p>
      </div>

      <div className={styles.card} data-testid="amendment-changes">
        <h3 className={styles.sectionTitle}>{t('contract.amendment.changesTitle')}</h3>
        {amendment.changes.length === 0 ? <p className={styles.muted}>{t('contract.amendment.changesEmpty')}</p> : null}
        {amendment.changes.map((ch) => {
          const rows = diffRows(ch);
          const delta = changeDelta(ch);
          const title = targetTitle(ch);
          return (
            <div className={styles.change} key={ch.id} data-testid="amendment-change">
              <div className={styles.changeHead}>
                <span className={styles.changeType}>{t(CHANGE_KEY[ch.type])}</span>
                {ch.target ? (
                  <span className={styles.changeTarget}>{title ?? t('contract.amendment.targetUnknown')}</span>
                ) : null}
              </div>
              {ch.type === 'custom_term' && str(ch.payload.text) ? <p className={styles.bodyText}>{str(ch.payload.text)}</p> : null}
              {rows.length > 0 ? (
                <dl className={styles.diff}>
                  {rows.map((r) => (
                    <div className={styles.diffRow} key={r.label}>
                      <dt className={styles.diffLabel}>{r.label}</dt>
                      <dd className={styles.diffValue}>
                        {r.was ? (
                          <>
                            <span className={styles.was}>{t('contract.amendment.was')}: <LtrText as="span">{r.was}</LtrText></span>
                            <span className={styles.arrow} aria-hidden="true">→</span>
                          </>
                        ) : null}
                        <span className={styles.becomes}>
                          {t(isSigned ? 'contract.amendment.became' : 'contract.amendment.becomes')}: <LtrText as="span">{r.becomes ?? '—'}</LtrText>
                        </span>
                      </dd>
                    </div>
                  ))}
                </dl>
              ) : null}
              {delta || ch.days_delta !== 0 ? (
                <p className={styles.deltaLine}>
                  {delta ? <LtrText as="span">{t('contract.amendment.amountDelta', { delta: formatMoney(delta) })}</LtrText> : null}
                  {delta && ch.days_delta !== 0 ? ' · ' : ''}
                  {ch.days_delta !== 0 ? t('contract.amendment.daysDelta', { days: ch.days_delta }) : null}
                </p>
              ) : null}
            </div>
          );
        })}
      </div>

      {antiWaiver ? (
        <Callout tone="info" title={t('contract.amendment.antiWaiverTitle')}>
          <span data-testid="amendment-anti-waiver">{antiWaiver}</span>
        </Callout>
      ) : null}

      {amendment.custom_terms ? (
        <div className={styles.card}>
          <h3 className={styles.sectionTitle}>{t('contract.amendment.customTermsTitle')}</h3>
          <p className={styles.bodyText} data-testid="amendment-custom-terms">{amendment.custom_terms}</p>
        </div>
      ) : null}

      {totalWas && totalBecomes && totalDelta ? (
        <div className={styles.card} data-testid="amendment-total">
          <h3 className={styles.sectionTitle}>{t('contract.amendment.totalTitle')}</h3>
          <p className={styles.totalLine}>
            <span className={styles.was}>{t('contract.amendment.was')}: <LtrText as="span">{formatMoney(totalWas)}</LtrText></span>
            <span className={styles.arrow} aria-hidden="true">→</span>
            <span className={styles.becomes}>{t(isSigned ? 'contract.amendment.became' : 'contract.amendment.becomes')}: <LtrText as="span">{formatMoney(totalBecomes)}</LtrText></span>
          </p>
          <p className={styles.deltaLine}><LtrText as="span">{t('contract.amendment.amountDelta', { delta: formatMoney(totalDelta) })}</LtrText></p>
        </div>
      ) : null}

      {version ? (
        <FrozenVersion
          title={t('signing.frozenVersionTitle')}
          version={t('signing.versionLabel', { date: formatDateTime(version.frozen_at, { legal: true }) })}
          hashShort={hashShort}
          hashLabel={t('signing.hashLabel')}
          tsaTime={version.trusted_timestamp_at ?? version.frozen_at}
          tsaLabel={t('signing.tsaLabel')}
          links={{
            stagesLabel: t('signing.stagesLink'),
            onStages: () => navigate(`/contracts/${id}`),
            checklistsLabel: t('signing.checklistsLink'),
            onChecklists: () => navigate(`/contracts/${id}`),
            materialsLabel: t('signing.materialsLink'),
            onMaterials: () => navigate(`/contracts/${id}`),
          }}
        />
      ) : status === 'under_review' ? (
        <Callout tone="neutral" title={t('signing.frozenVersionTitle')}>{t('contract.amendment.underReviewText')}</Callout>
      ) : null}

      {status !== 'draft' && !closed ? (
        <div className={styles.card}>
          <h3 className={styles.sectionTitle}>{t('signing.signaturesTitle')}</h3>
          {customerParty ? (
            <SignatureRow
              name={t('contract.roleCustomer')}
              role={t('contract.roleCustomer')}
              youLabel={t('signing.sigYou')}
              waitingLabel={t('signing.sigWaiting')}
              signedLabel={t('signing.sigSigned')}
              {...rowState(latestRequestForSide(sigReqs, 'customer'), 'customer')}
            />
          ) : null}
          {contractorParty ? (
            <SignatureRow
              name={t('contract.roleContractor')}
              role={t('contract.roleContractor')}
              youLabel={t('signing.sigYou')}
              waitingLabel={t('signing.sigWaiting')}
              signedLabel={t('signing.sigSigned')}
              {...rowState(latestRequestForSide(sigReqs, 'contractor'), 'contractor')}
            />
          ) : null}
        </div>
      ) : null}

      {(noSignatory || signatoryKnownEmpty) && actionable ? (
        <Callout tone="warn" title={t('signing.realNoSignatoryTitle')}>{t('signing.realNoSignatoryText')}</Callout>
      ) : null}

      {isSigned ? (
        <div className={styles.card} data-testid="amendment-signed">
          <span role="img" aria-label={t('contract.amendment.signedTitle')}>
            <Logo variant="mark" size={64} />
          </span>
          <h3 className={styles.sectionTitle}>{t('contract.amendment.signedTitle')}</h3>
          <p className={styles.muted}>{t('contract.amendment.signedText')}</p>
        </div>
      ) : status === 'draft' && myRole ? (
        /* ADR-161 §2: черновик правит и выбрасывает только ИНИЦИАТОР. Второй
           стороне черновик вообще не виден (бэк отдаёт 404), но у стороны,
           которая на него как-то попала, кнопок правки нет — последнее слово
           всё равно за бэком (403 `not_initiator`). */
        <div className={styles.actionsBar}>
          <Button variant="primary" block loading={send.isPending} disabled={anyPending} onClick={() => void run(() => send.mutateAsync())} data-testid="amendment-send">
            {t('contract.amendment.sendCta')}
          </Button>
          {isInitiator ? (
            <>
              <Button variant="secondary" block disabled={anyPending} onClick={() => setEditOpen(true)} data-testid="amendment-edit">
                {t('contract.amendment.editCta')}
              </Button>
              <Button variant="destructive" block disabled={anyPending} onClick={() => setDeleteOpen(true)} data-testid="amendment-delete">
                {t('contract.amendment.deleteCta')}
              </Button>
            </>
          ) : null}
        </div>
      ) : mySigned ? (
        <>
          <Callout tone="neutral">{t('signing.oneSignatureWaiting')}</Callout>
          {canWithdraw ? (
            <div className={styles.actionsBar}>
              <Button variant="secondary" block disabled={anyPending} onClick={() => setCloseKind('withdraw')} data-testid="amendment-withdraw">
                {t('contract.amendment.withdrawCta')}
              </Button>
            </div>
          ) : null}
        </>
      ) : actionable ? (
        <div className={styles.actionsBar}>
          <Button variant="primary" block loading={signing} disabled={anyPending || signBlocked} onClick={() => void onSign()} data-testid="amendment-sign">
            {t('signing.signCta')}
          </Button>
          {canReturn ? (
            <Button variant="secondary" block disabled={anyPending} onClick={() => setReturnOpen(true)} data-testid="amendment-return">
              {t('signing.realDeclineCta')}
            </Button>
          ) : null}
          {canReject ? (
            <Button variant="destructive" block disabled={anyPending} onClick={() => setCloseKind('reject')} data-testid="amendment-reject">
              {t('contract.amendment.rejectCta')}
            </Button>
          ) : null}
          {canWithdraw ? (
            <Button variant="secondary" block disabled={anyPending} onClick={() => setCloseKind('withdraw')} data-testid="amendment-withdraw">
              {t('contract.amendment.withdrawCta')}
            </Button>
          ) : null}
        </div>
      ) : null}

      <div className={styles.card}>
        <h3 className={styles.sectionTitle}>{t('contract.amendment.timelineTitle')}</h3>
        {timeline.length === 0 ? <p className={styles.muted}>{t('contract.amendment.timelineEmpty')}</p> : null}
        <div className={styles.timeline} data-testid="amendment-timeline">
          {timeline.map((e) => {
            // ADR-134: подписи `title`/`detail` приходят с бэка (тот же
            // сериализатор, что у хроники договора); без подписи — «Событие»
            // + код мелко, как в `RealTimelinePanel`. Причина отклонения/
            // отзыва — `detail`-фолбэк из payload, если бэк `detail` не дал.
            const kind = timelineKind(e);
            const title = timelineTitle(e);
            const detail = e.detail ?? (kind === 'amendment.rejected' || kind === 'amendment.withdrawn' ? eventReason(e.payload) : undefined);
            return (
              <div className={styles.tlItem} key={e.event_id} data-testid="amendment-timeline-item" data-kind={kind}>
                <span className={styles.tlTime}>{formatDateTime(e.occurred_at)}</span>
                <div className={styles.tlBody}>
                  {title ? (
                    <span>{title}</span>
                  ) : (
                    <span>
                      {t('contract.timeline.eventFallback')} <code className={styles.tlCode}>{kind}</code>
                    </span>
                  )}
                  {detail ? <span className={styles.tlDetail}>{detail}</span> : null}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {version ? (
        <Ceremony
          open={ceremonyOpen}
          title={t('contract.amendment.ceremonyTitle')}
          subtitle={t('contract.amendment.ceremonySubtitle')}
          doneLabel={t('contract.amendment.backToContract')}
          chip={<SignResult chip={t('signing.ceremonyChip', { version: version.id, hash: hashShort, date: formatDateTime(version.trusted_timestamp_at ?? version.frozen_at, { legal: true }) })} />}
          onDone={() => navigate(`/contracts/${id}`)}
        />
      ) : null}

      <Modal
        open={closeKind !== null}
        title={t(closeKind === 'reject' ? 'contract.amendment.rejectCta' : 'contract.amendment.withdrawCta')}
        onClose={closeCloseModal}
        closeLabel={t('common.close')}
        actions={
          <>
            <Button variant="ghost" onClick={closeCloseModal}>{t('common.cancel')}</Button>
            <Button
              variant={closeKind === 'reject' ? 'destructive' : 'secondary'}
              onClick={() => void onConfirmClose()}
              loading={reject.isPending || withdraw.isPending}
              data-testid="amendment-close-confirm"
            >
              {t(closeKind === 'reject' ? 'contract.amendment.rejectCta' : 'contract.amendment.withdrawCta')}
            </Button>
          </>
        }
      >
        <p className={styles.muted}>{t(closeKind === 'reject' ? 'contract.amendment.rejectText' : 'contract.amendment.withdrawText')}</p>
        <TextArea
          label={t('contract.amendment.closeReasonLabel')}
          rows={3}
          value={closeReason}
          onChange={(e) => setCloseReason(e.target.value)}
          data-testid="amendment-close-reason"
        />
      </Modal>

      {contract ? (
        <RealAmendmentFormModal
          open={editOpen}
          contract={contract}
          initial={amendment}
          onClose={() => setEditOpen(false)}
          pending={update.isPending}
          error={err ?? undefined}
          onSubmit={(input, andSend) => {
            void run(async () => {
              await update.mutateAsync(input);
              if (andSend) await send.mutateAsync();
            }).then((ok) => {
              if (ok) setEditOpen(false);
            });
          }}
        />
      ) : null}

      <Modal
        open={deleteOpen}
        title={t('contract.amendment.deleteCta')}
        onClose={() => setDeleteOpen(false)}
        closeLabel={t('common.close')}
        actions={
          <>
            <Button variant="ghost" onClick={() => setDeleteOpen(false)}>{t('common.cancel')}</Button>
            <Button
              variant="destructive"
              loading={remove.isPending}
              data-testid="amendment-delete-confirm"
              onClick={() => {
                void run(() => remove.mutateAsync()).then((ok) => {
                  setDeleteOpen(false);
                  // Черновика больше нет — на его экране оставаться незачем.
                  if (ok) navigate(`/contracts/${id}#amendments`);
                });
              }}
            >
              {t('contract.amendment.deleteConfirmCta')}
            </Button>
          </>
        }
      >
        <p className={styles.muted}>{t('contract.amendment.deleteText')}</p>
      </Modal>

      <Modal
        open={returnOpen}
        title={t('signing.realDeclineCta')}
        onClose={() => setReturnOpen(false)}
        closeLabel={t('common.close')}
        actions={
          <>
            <Button variant="ghost" onClick={() => setReturnOpen(false)}>{t('common.cancel')}</Button>
            <Button variant="secondary" onClick={() => void onConfirmReturn()} loading={decline.isPending} disabled={!returnComment.trim()} data-testid="amendment-return-confirm">
              {t('signing.realDeclineCta')}
            </Button>
          </>
        }
      >
        <TextField
          label={t('signing.realDeclineCommentLabel')}
          help={t('hints.signing.declineComment')}
          helpLabel={t('hints.helpButton')}
          value={returnComment}
          onChange={(e) => setReturnComment(e.target.value)}
          data-testid="amendment-return-comment"
        />
      </Modal>
    </div>
  );
}

