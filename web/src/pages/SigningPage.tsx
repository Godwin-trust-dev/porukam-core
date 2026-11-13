import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ApiError, type ContractDetail, type ContractRole } from '@porukam/core';
import {
  AiSummaryCard,
  AutoTranslateBadge,
  Badge,
  Button,
  Callout,
  Ceremony,
  CustomTermsBlock,
  EditContractLink,
  ErrorState,
  FrozenVersion,
  Modal,
  OfficialTextLine,
  OfficialTextView,
  PaymentPolicyLine,
  Skeleton,
  SignatureRow,
  Logo,
  TextField,
  type SignatureRowState,
} from '@porukam/ui';
import { useSigningApi, useSigningContract, usePaymentPolicy } from '../features/signing/api';
import { useViewerStore } from '../features/contracts/viewerStore';
import { useActorStore } from '../features/actor/actorStore';
import { useCurrentUser } from '../features/auth/useAuth';
import { useRealContract, useRejectRealContract, useReturnForRevision, useWithdrawRealContract } from '../features/contracts/realApi';
import { isRealContractId } from '../features/contracts/realDispatch';
import { CounterpartyLink } from '../features/counterparty/CounterpartyLink';
import { useOwnProfileSettings } from '../features/profile/api';
import { RetentionNotice } from '../features/contracts/RetentionNotice';
import {
  useContractSignatureRequests,
  useContractVersion,
  useCreateSignatureRequest,
  useForwardSignatureRequest,
  useFreezeContract,
  useSignatories,
  useSignSignatureRequest,
} from '../features/contracts/realSigningApi';
import { useFormatters } from '../shared/formatters';
import styles from './SigningPage.module.css';
import { apiErrorText } from '../shared/apiErrorText';

// Отсмотр 2026-08-21: «Переадресовать» — маршрутизация подписи внутри
// организации (B2B, SigningAuthority), в C2C-запуске скрыта. «Вернуть на
// доработку» ВОЗВРАЩЕНА (решение 2026-08-23): это вход в протокол
// разногласий с экрана подписания — к B2B отношения не имеет; с 2026-08-25
// идёт через `return_for_revision` (ADR-124, любой стороной, без заявки на
// подпись), а «заявка на подпись» как отдельный шаг из UI убрана: «Подписать»
// сама замораживает версию, создаёт заявку и подписывает.
const B2B_SIGNING_ROUTING = false;

/** Диспетчер real/мок — правило в `isRealContractId` (общее для карточки,
 * подписания и этапа). */
export function SigningPage(): JSX.Element {
  const { id = '' } = useParams();
  return isRealContractId(id) ? <RealSigningPage id={id} /> : <LegacySigningPage id={id} />;
}

/**
 * DEV-05 · Подписание договора + церемония «по рукам» — `/contracts/:id/sign`.
 * Единый светлый экран для обеих сторон, одна кнопка «Подписать» у всех
 * (финмодель v2, DEV-05-PATCH v2: комиссия за заключение отменена полностью —
 * `paymentPolicy.contractFee.applies` всегда false, из политики; `CommissionSection`
 * на этом экране не используется — комиссия вернётся только подпиской, другим
 * механизмом; см. docs/tasks/DEV-05-patch_jurisdiction-money.md).
 */
function LegacySigningPage({ id }: { id: string }): JSX.Element {
  const { t } = useTranslation();
  const { formatDate, formatPolicyMoney } = useFormatters();
  const navigate = useNavigate();
  const location = useLocation();
  const { data: c, isPending, error, refetch } = useSigningContract(id);
  const api = useSigningApi(id);
  const viewAs = useViewerStore((s) => s.viewAs);

  const [err, setErr] = useState<string | null>(null);
  const [ceremonyOpen, setCeremonyOpen] = useState(!!(location.state as { justSigned?: boolean } | null)?.justSigned);
  const [verificationGate, setVerificationGate] = useState(false);
  const [simulateVerification, setSimulateVerification] = useState(false);
  const [showOfficial, setShowOfficial] = useState(false); // DEV-16b §3 — «Официальный текст — English · показать»
  const requestedRef = useRef(false);
  const summaryShownRef = useRef(false);

  useEffect(() => {
    if (!c) return;
    if (c.status === 'pending_signature' && !requestedRef.current) {
      requestedRef.current = true;
      void api.ensureRequested(c).catch((e) => setErr(e instanceof ApiError ? e.message : String(e)));
    }
  }, [c?.status]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!c) return;
    if (c.version && !c.ai_summary_shown && !summaryShownRef.current) {
      summaryShownRef.current = true;
      void api.showAiSummary().catch(() => {});
    }
  }, [c?.version, c?.ai_summary_shown]); // eslint-disable-line react-hooks/exhaustive-deps

  if (isPending || !c) {
    return (
      <div className={styles.wrap} data-density="cozy">
        <Skeleton width="60%" height={30} />
        <Skeleton width="100%" height={120} radius="var(--pr-r-lg)" />
        <Skeleton width="100%" height={200} radius="var(--pr-r-lg)" />
      </div>
    );
  }

  if (error) {
    return (
      <div className={styles.wrap} data-density="cozy">
        <ErrorState
          title={t('signing.errorText')}
          text={apiErrorText(error)}
          code={error instanceof ApiError ? error.code : undefined}
          retryLabel={t('common.retry')}
          onRetry={() => void refetch()}
        />
      </div>
    );
  }

  if (!c.version) {
    return (
      <div className={styles.wrap} data-density="cozy">
        <Callout tone="neutral" title={t('signing.notFrozenTitle')}>
          {t('signing.notFrozenText')}
        </Callout>
        <Button variant="ghost" onClick={() => navigate(`/contracts/${id}`)}>
          {t('signing.backToContract')}
        </Button>
      </div>
    );
  }

  const version = c.version;
  const paymentPolicy = usePaymentPolicy(c);
  const viewerRole = viewAs;
  const preparing = c.status === 'pending_signature';
  const mySig = c.signatures.some((s) => s.role === viewerRole);
  const custParty = c.parties.find((p) => p.role === 'customer');
  const contrParty = c.parties.find((p) => p.role === 'contractor');
  const hashShort = `${version.integrity_hash.slice(0, 18)}…`;

  const partyState = (role: 'customer' | 'contractor'): { state: SignatureRowState; signedAt?: string } => {
    const sig = c.signatures.find((s) => s.role === role);
    if (sig) return { state: 'signed', signedAt: sig.signed_at };
    return { state: role === viewerRole ? 'you' : 'waiting' };
  };

  async function run(fn: () => Promise<ContractDetail>): Promise<void> {
    setErr(null);
    try {
      const updated = await fn();
      if (updated.status === 'signed') setCeremonyOpen(true);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : String(e));
    }
  }

  function handleSign(): void {
    if (simulateVerification) {
      setVerificationGate(true);
      return;
    }
    void run(() => api.sign());
  }

  function handleReopen(): void {
    // DEV-10 §1/§6 — «Отклонить на доработку» ведёт на протокол разногласий (under_review),
    // не на карточку договора; комментарий подписанта приходит первой правкой (§6, мок).
    void run(() => api.reopen()).then(() => navigate(`/contracts/${id}/review`));
  }

  return (
    <div className={styles.wrap} data-density="cozy">
      <div className={styles.head}>
        <h1 className={styles.title}>{c.title}</h1>
        <div className={styles.meta}>
          {/* Бэклог 2026-08-21: вторая сторона — ссылка на её публичную карточку. */}
          {(() => {
            const other = c.parties.find((p) => p.role !== viewerRole);
            return other ? (
              <CounterpartyLink
                profileId={other.profile_id}
                name={other.display_name}
                handle={other.handle}
                showAvatar
                data-testid="signing-counterparty"
              />
            ) : null;
          })()}
          <span>
            {t('signing.sum')}: {formatPolicyMoney(c.total, paymentPolicy.currency)}
          </span>
          <Badge tone="teal">{t('signing.frozenBadge')}</Badge>
        </div>
      </div>

      {err ? <Callout tone="warn">{err}</Callout> : null}

      <AiSummaryCard
        badgeLabel={t('signing.aiSummaryBadge')}
        title={t('signing.aiSummaryTitle')}
        items={version.ai_summary_items}
        fullTextLabel={t('signing.aiSummaryFullText')}
        onFullText={() => navigate(`/contracts/${id}`)}
        disclaimer={t('signing.aiSummaryDisclaimer')}
      />

      {/* DEV-16b §0/§3 — язык договора: одноязычная сделка (is_cross_language=false) —
          ничего из этого не рендерится вовсе (чистый экран, §0.2). */}
      {version.is_cross_language && version.viewer_render ? (
        <div className={styles.languageBlock}>
          <AutoTranslateBadge label={t('signing.crossLanguageBadge')} tooltip={t('signing.crossLanguageBadgeTooltip')} />
          <p className={styles.bodyText}>{version.viewer_render.body}</p>
          <OfficialTextLine
            prefix={t('signing.officialTextLinePrefix')}
            expanded={showOfficial}
            showLabel={t('signing.officialTextShow')}
            hideLabel={t('signing.officialTextHide')}
            onToggle={() => setShowOfficial((v) => !v)}
          />
          <OfficialTextView
            open={showOfficial}
            onClose={() => setShowOfficial(false)}
            closeLabel={t('common.close')}
            sheetTitle={t('signing.officialTextSheetTitle')}
            sheetSubtitle={t('signing.officialTextSheetSubtitle')}
            footnote={t('signing.officialTextFootnote')}
            officialText={version.official_render.body ?? ''}
            viewerLabel={t('signing.compareYourLanguage')}
            viewerText={version.viewer_render.body ?? ''}
            officialLabel={t('signing.compareOfficial')}
          />
        </div>
      ) : version.is_cross_language ? (
        <div className={styles.languageBlock}>
          <p className={styles.bodyText}>{version.official_render.body}</p>
          <Callout tone="neutral">{t('signing.noRenderNotice')}</Callout>
        </div>
      ) : null}

      <PaymentPolicyLine
        title={t(paymentPolicy.transferFee.labelKey)}
        note={t(paymentPolicy.transferFee.noteKey)}
        positive={!paymentPolicy.transferFee.platformTakesCommission}
      />

      <PaymentPolicyLine
        title={t(paymentPolicy.contractFee.labelKey)}
        note={t(paymentPolicy.contractFee.noteKey)}
        positive={!paymentPolicy.contractFee.applies}
      />

      <FrozenVersion
        title={t('signing.frozenVersionTitle')}
        version={t('signing.versionLabel', { date: formatDate(version.created_at, { legal: true }) })}
        hashShort={hashShort}
        hashLabel={t('signing.hashLabel')}
        tsaTime={version.tsa_time}
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

      {c.custom_terms ? (
        <CustomTermsBlock
          title={t('signing.customTermsLabel')}
          tag={t('signing.customTermsTag')}
          text={c.custom_terms.text}
          translateCta={t('signing.customTermsTranslateCta')}
        />
      ) : null}

      <div className={styles.card}>
        <h3 className={styles.sectionTitle}>{t('signing.signaturesTitle')}</h3>
        {custParty ? (
          <SignatureRow
            name={custParty.display_name}
            role={t('contract.roleCustomer')}
            signerNote={custParty.signer_note}
            youLabel={t('signing.sigYou')}
            waitingLabel={t('signing.sigWaiting')}
            signedLabel={t('signing.sigSigned')}
            {...partyState('customer')}
          />
        ) : null}
        {contrParty ? (
          <SignatureRow
            name={contrParty.display_name}
            role={t('contract.roleContractor')}
            signerNote={contrParty.signer_note}
            youLabel={t('signing.sigYou')}
            waitingLabel={t('signing.sigWaiting')}
            signedLabel={t('signing.sigSigned')}
            {...partyState('contractor')}
          />
        ) : null}
      </div>

      <EditContractLink
        label={t('signing.editLink')}
        warning={t('signing.editWarning')}
        enabled={c.status !== 'signed'}
        onEdit={handleReopen}
      />

      {c.status !== 'signed' ? (
        <label className={styles.devToggle}>
          <input
            type="checkbox"
            checked={simulateVerification}
            onChange={(e) => setSimulateVerification(e.target.checked)}
            data-testid="simulate-verification-gate"
          />
          {t('signing.simulateVerification')}
        </label>
      ) : null}

      {verificationGate ? (
        <Callout tone="warn" title={t('signing.verificationGateTitle')}>
          {t('signing.verificationGateText')}
          <div className={styles.gateAction}>
            <Button variant="secondary" size="sm" onClick={() => navigate('/me/verify/esica')}>
              {t('signing.verificationGateCta')}
            </Button>
          </div>
        </Callout>
      ) : null}

      {/* ADR-137 требование 9: сроки хранения документов — над кнопками подписи. */}
      <RetentionNotice />

      {mySig && c.status !== 'signed' ? <Callout tone="neutral">{t('signing.oneSignatureWaiting')}</Callout> : null}

      {c.status !== 'signed' && !mySig ? (
        <div className={styles.actionsBar}>
          <Button variant="primary" block loading={preparing} onClick={handleSign} data-testid="sign-cta">
            {t('signing.signCta')}
          </Button>
        </div>
      ) : null}

      <Ceremony
        open={ceremonyOpen}
        title={t('signing.ceremonyTitle')}
        subtitle={t('signing.ceremonySubtitle', { title: c.title })}
        doneLabel={t('signing.ceremonyDone')}
        eyebrow={t('signing.ceremonyEyebrow')}
        facts={[
          { label: t('signing.ceremonyTimestamp'), value: formatDate(version.tsa_time, { legal: true }) },
          { label: t('signing.ceremonyHash'), value: hashShort, accent: true },
        ]}
        chip={version.is_cross_language ? t('signing.signResultLanguageNote') : undefined}
        onDone={() => navigate(`/contracts/${id}`)}
      />
    </div>
  );
}

// ═══════════════════════════════════ Реальный контур: заморозка + 2-шаговое подписание (ADR-088, Фаза 4) ═══

/** Самая свежая заявка на конкретную сторону — `list_signature_requests`
 * (`-sent_at`, реальный бэк) отдаёт ВСЮ историю, не только текущий раунд;
 * массив здесь приходит в том же порядке (мок зеркалит), первое совпадение
 * по стороне и есть «текущее» состояние этой стороны. */
function latestRequestForSide(requests: import('@porukam/core').RealSignatureRequest[], side: ContractRole | undefined) {
  return side ? requests.find((r) => r.side === side) : undefined;
}

function RealSigningPage({ id }: { id: string }): JSX.Element {
  const { t } = useTranslation();
  const { formatDateTime, formatMoney } = useFormatters();
  const navigate = useNavigate();

  const contractQ = useRealContract(id);
  const sigReqsQ = useContractSignatureRequests(id);
  const meQ = useCurrentUser();

  const [err, setErr] = useState<string | null>(null);
  const [justSignedAt, setJustSignedAt] = useState<string | undefined>();
  const [ceremonyOpen, setCeremonyOpen] = useState(false);
  const [returnOpen, setReturnOpen] = useState(false);
  const [returnComment, setReturnComment] = useState('');
  const [rejectOpen, setRejectOpen] = useState(false);
  // «Подписать» — цепочка из до трёх запросов (заморозка → заявка → подпись);
  // одно состояние загрузки на всю цепочку, не по мутациям.
  const [signing, setSigning] = useState(false);
  const [noSignatory, setNoSignatory] = useState(false);
  const wasSignedRef = useRef<boolean | null>(null);

  const freeze = useFreezeContract(id);
  const createSignatureRequest = useCreateSignatureRequest(id);
  const sign = useSignSignatureRequest(id);
  const forward = useForwardSignatureRequest(id);
  const returnForRevision = useReturnForRevision(id);
  const reject = useRejectRealContract(id);
  const withdraw = useWithdrawRealContract(id);

  const contract = contractQ.data;
  const sigReqs = sigReqsQ.data ?? [];
  // id ТЕКУЩЕЙ заморозки — прямо из `ContractSerializer` (frozen_version_id
  // добавлен на бэке; `null` — не заморожен или заморозка снята). Приходит тем
  // же ответом, что и `negotiation_status`, — никакой гонки с хроникой.
  const effectiveVersionId = contract?.frozen_version_id ?? undefined;
  const versionQ = useContractVersion(id, effectiveVersionId);

  const myProfileId = useActorStore((s) => s.activeProfileId);
  const myParty = contract?.parties.find((p) => p.profile_id === myProfileId);
  const myRole = myParty?.role;
  const isInitiator = !!myRole && myRole === contract?.initiator_role;

  const signatoriesQ = useSignatories(id, myRole);
  // Имя второй стороны для строки сторон в церемонии (DEV-20_2 §9). Тот же
  // публичный `GET /profiles/{id}`, что резолвит `CounterpartyLink` выше по
  // экрану, — react-query отдаёт его из кеша, второго запроса нет.
  const ceremonyCounterpartyQ = useOwnProfileSettings(
    contract?.parties.find((p) => p.profile_id !== myProfileId)?.profile_id,
  );

  const mySigReq = latestRequestForSide(sigReqs, myRole);

  useEffect(() => {
    if (!contract) return;
    const nowSigned = contract.negotiation_status === 'signed';
    if (wasSignedRef.current === false && nowSigned) setCeremonyOpen(true);
    wasSignedRef.current = nowSigned;
  }, [contract]);

  if (contractQ.isPending) {
    return (
      <div className={styles.wrap} data-density="cozy">
        <Skeleton width="60%" height={30} />
        <Skeleton width="100%" height={120} radius="var(--pr-r-lg)" />
        <Skeleton width="100%" height={200} radius="var(--pr-r-lg)" />
      </div>
    );
  }
  if (contractQ.error || !contract) {
    return (
      <div className={styles.wrap} data-density="cozy">
        <ErrorState
          title={t('signing.errorText')}
          text={apiErrorText(contractQ.error)}
          code={contractQ.error instanceof ApiError ? contractQ.error.code : undefined}
          retryLabel={t('common.retry')}
          onRetry={() => void contractQ.refetch()}
        />
      </div>
    );
  }

  // Ошибки предметно (422/409 из `freeze_contract`): без понятного текста
  // человек видит тот же экран и жмёт кнопку по кругу (отсмотр прода
  // 2026-08-21). Коды и тексты — те же, что на ContractReviewPage; для прочих
  // показываем detail бэка вместе с кодом.
  function describeError(e: unknown): string {
    if (e instanceof ApiError) {
      if (e.code === 'requisites_missing') return t('contract.errRequisites');
      if (e.code === 'open_revisions') return t('contract.errOpenRevisions');
      if (e.code === 'leaf_sum_mismatch') return t('contract.errLeafMismatch');
      return e.code ? `${e.message} (${e.code})` : e.message;
    }
    return String(e);
  }

  /** Общий запуск мутации: ошибка — в баннер, результат — `true`/`false`. */
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

  /** «Подписать» одним нажатием (решение 2026-08-25: «заявка на подпись» как
   * отдельный шаг убрана из UI): под согласованием — сначала заморозка версии
   * (`under_review -> pending_signature`), затем заявка на подпись своей
   * стороны, если её ещё нет, затем сама подпись на integrity_hash ТЕКУЩЕЙ
   * версии. Любая ступень падает — цепочка останавливается, текст ошибки
   * тот же, что раньше у отдельных кнопок. */
  async function onSign(): Promise<void> {
    if (!myRole || !contract || signing) return;
    setNoSignatory(false);
    setSigning(true);
    try {
      await run(async () => {
        let status = contract.negotiation_status;
        let versionId = effectiveVersionId;
        let versionHash = versionQ.data?.integrity_hash;
        if (status === 'under_review') {
          const frozen = await freeze.mutateAsync();
          versionId = frozen.id;
          versionHash = frozen.integrity_hash;
          status = (await contractQ.refetch()).data?.negotiation_status ?? 'pending_signature';
        }
        if (!versionId || !versionHash) return;

        let request = status === 'awaiting_signatures' && mySigReq?.status === 'pending' ? mySigReq : undefined;
        if (!request) {
          // Подписант своей стороны — Р1 без `apps.authority`: для business-
          // стороны список пуст, честно останавливаемся (`realNoSignatoryText`).
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

  async function onForward(): Promise<void> {
    if (!mySigReq) return;
    await run(() => forward.mutateAsync({ signatureRequestId: mySigReq.id, input: {} }));
  }

  /** «Вернуть на доработку» (ADR-124): с этапа подписания — любой стороной,
   * без заявки на подпись; раунд аннулируется, договор снова на
   * согласовании — ведём на карточку (там протокол разногласий). */
  async function onConfirmReturn(): Promise<void> {
    const comment = returnComment.trim();
    if (!comment) return;
    const ok = await run(() => returnForRevision.mutateAsync({ comment }));
    setReturnOpen(false);
    if (ok) {
      setReturnComment('');
      navigate(`/contracts/${id}`);
    }
  }

  /** «Отклонить» (§6.1, ADR-124): инициатор — `withdraw`, вторая сторона —
   * `reject`; терминально, из заморозки — с аннулированием раунда. */
  async function onConfirmReject(): Promise<void> {
    const ok = await run(() => (isInitiator ? withdraw.mutateAsync() : reject.mutateAsync()));
    setRejectOpen(false);
    if (ok) navigate(`/contracts/${id}`);
  }

  const status = contract.negotiation_status;
  const underReview = status === 'under_review';
  const frozenState = status === 'pending_signature' || status === 'awaiting_signatures' || status === 'signed';

  // ── Не отправлен на согласование вовсе — рано даже для заморозки ──
  if (status === 'draft') {
    return (
      <div className={styles.wrap} data-density="cozy">
        <Callout tone="neutral" title={t('signing.realNotReadyTitle')}>{t('signing.realNotReadyText')}</Callout>
        <Button variant="ghost" onClick={() => navigate(`/contracts/${id}`)}>{t('signing.backToContract')}</Button>
      </div>
    );
  }

  // ── Согласование закрыто отказом — подписывать нечего. Своя ветка, а не
  // «неизвестна версия»: с ADR-124 отклонить/отозвать можно прямо с этого
  // экрана, и человек остаётся на нём же — текст должен объяснять, что
  // произошло, а не предлагать обновить страницу. ──
  if (status === 'rejected_by_counterparty' || status === 'withdrawn_by_initiator') {
    return (
      <div className={styles.wrap} data-density="cozy">
        <Callout tone="neutral" title={t('signing.realClosedTitle')}>{t('signing.realClosedText')}</Callout>
        <Button variant="ghost" onClick={() => navigate(`/contracts/${id}`)}>{t('signing.backToContract')}</Button>
      </div>
    );
  }

  // ── Заморожен — id версии уже в `contract.frozen_version_id`; пока сама
  // версия грузится — skeleton, не «неизвестно». `realVersionUnknown` —
  // редкий защитный край (статус заморожен, а frozen_version_id пуст). ──
  if (frozenState && effectiveVersionId && versionQ.isPending) {
    return (
      <div className={styles.wrap} data-density="cozy">
        <Skeleton width="60%" height={30} />
        <Skeleton width="100%" height={120} radius="var(--pr-r-lg)" />
      </div>
    );
  }
  if (!underReview && !effectiveVersionId) {
    return (
      <div className={styles.wrap} data-density="cozy">
        <Callout tone="neutral" title={t('signing.notFrozenTitle')}>{t('signing.realVersionUnknown')}</Callout>
        <Button variant="ghost" onClick={() => navigate(`/contracts/${id}`)}>{t('signing.backToContract')}</Button>
      </div>
    );
  }
  const version = underReview ? undefined : versionQ.data;
  if (!underReview && (versionQ.error || !version)) {
    return (
      <div className={styles.wrap} data-density="cozy">
        <ErrorState title={t('signing.errorText')} retryLabel={t('common.retry')} onRetry={() => void versionQ.refetch()} />
      </div>
    );
  }

  const hashShort = version ? `${version.integrity_hash.slice(0, 18)}…` : '';
  const isCrossLanguage = version ? Object.keys(version.renders).length > 1 : false;
  // ADR-123: дополнительные условия (принятые правки «Другое») входят в снимок
  // и в `integrity_hash` — человек не должен подписывать текст, которого не видел.
  // До заморозки (`under_review`, три кнопки ADR-124) версии ещё нет — берём
  // текущие условия договора.
  const snapshotTerms = (version?.snapshot as { additional_terms?: unknown } | undefined)?.additional_terms;
  const additionalTerms: string[] = (Array.isArray(snapshotTerms) ? snapshotTerms : contract.additional_terms ?? []).map(String);

  function rowState(sigReq: import('@porukam/core').RealSignatureRequest | undefined, side: ContractRole | undefined): { state: SignatureRowState; signedAt?: string } {
    if (sigReq?.status === 'signed') {
      // Реальный бэк не отдаёт список подписей отдельно (`signatures` — B/C
      // композиция, ADR-088) и `SignatureRequestSerializer` не несёт
      // `signed_at` — точное время известно ТОЛЬКО для подписи, которую
      // сделали МЫ в этой сессии (ответ мутации `sign`), для чужой — просто
      // «подписано», без метки времени (честно, не выдумываем).
      return { state: 'signed', signedAt: side === myRole ? justSignedAt : undefined };
    }
    if (sigReq?.status === 'pending' && side === myRole) return { state: 'you' };
    return { state: 'waiting' };
  }

  const customerParty = contract.parties.find((p) => p.role === 'customer');
  const contractorParty = contract.parties.find((p) => p.role === 'contractor');
  const counterpartyParty = contract.parties.find((p) => p.profile_id !== myProfileId);

  const mySigned = mySigReq?.status === 'signed';
  const actionable = !!myRole && status !== 'signed' && !mySigned;
  const anyPending =
    signing || freeze.isPending || createSignatureRequest.isPending || sign.isPending || forward.isPending
    || returnForRevision.isPending || reject.isPending || withdraw.isPending;
  // Заявка адресована не мне (B2B-маршрутизация внутри организации) —
  // подписывать не могу; список подписантов пуст (business-сторона, Р1) —
  // подписать тоже нечем: честно блокируем ТОЛЬКО «Подписать», вернуть на
  // доработку и отклонить можно всё равно.
  const signatoryKnownEmpty = (signatoriesQ.data?.length ?? -1) === 0 && mySigReq?.status !== 'pending';
  const signBlocked =
    (mySigReq?.status === 'pending' && !!meQ.data && mySigReq.signatory_id !== meQ.data.id) || signatoryKnownEmpty;

  return (
    <div className={styles.wrap} data-density="cozy">
      <div className={styles.head}>
        <h1 className={styles.title}>{contract.title || t('contracts.titleUnset')}</h1>
        <div className={styles.meta}>
          {myRole ? <Badge tone="ink">{t('signing.realSigningAs')}: {t(myRole === 'customer' ? 'contract.roleCustomer' : 'contract.roleContractor')}</Badge> : null}
          {/* Бэклог 2026-08-21: вторая сторона на экране подписания — ссылка на
              её публичную карточку + копирование хендла. */}
          {counterpartyParty ? (
            <CounterpartyLink profileId={counterpartyParty.profile_id} showAvatar data-testid="signing-counterparty" />
          ) : null}
          <span>{t('signing.sum')}: {contract.total ? formatMoney(contract.total) : t('contracts.amountUnset')}</span>
          {version ? <Badge tone="teal">{t('signing.frozenBadge')}</Badge> : null}
        </div>
      </div>

      {err ? <div data-testid="signing-error"><Callout tone="warn">{err}</Callout></div> : null}

      {isCrossLanguage ? (
        <div className={styles.languageBlock}>
          <AutoTranslateBadge label={t('signing.crossLanguageBadge')} tooltip={t('signing.crossLanguageBadgeTooltip')} />
        </div>
      ) : null}

      {additionalTerms.length > 0 ? (
        <div className={styles.additionalTerms} data-testid="signing-additional-terms">
          <h2 className={styles.additionalTitle}>{t('contract.termsAdditionalTitle')}</h2>
          <ol className={styles.additionalList}>
            {additionalTerms.map((term, i) => (
              <li key={`${i}-${term}`}>{term}</li>
            ))}
          </ol>
        </div>
      ) : null}

      <PaymentPolicyLine title={t('signing.freeCoreTitle')} note={t('signing.freeCoreNote')} positive />

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
      ) : (
        // Под согласованием версии ещё нет — заморозка случится по «Подписать»
        // (первая ступень цепочки), отдельного шага «Заморозить» больше нет.
        <Callout tone="neutral" title={t('signing.frozenVersionTitle')}>{t('signing.signWillFreezeText')}</Callout>
      )}

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

      {/* ADR-137 требование 9: сроки хранения документов — над кнопками
          подписи, тем же тоном, что и обещание о подлинности. */}
      <RetentionNotice />

      {(noSignatory || signatoryKnownEmpty) && actionable ? (
        <Callout tone="warn" title={t('signing.realNoSignatoryTitle')}>{t('signing.realNoSignatoryText')}</Callout>
      ) : null}

      {status === 'signed' ? (
        <div className={styles.card}>
          {/* Подтверждающий момент — знак, вспышка в нём самом (DEV-17 §3). */}
          <span role="img" aria-label={t('signing.ceremonyTitle')}>
            <Logo variant="mark" size={64} />
          </span>
          <h3 className={styles.sectionTitle}>{t('signing.ceremonyTitle')}</h3>
        </div>
      ) : mySigned ? (
        <Callout tone="neutral">{t('signing.oneSignatureWaiting')}</Callout>
      ) : actionable ? (
        // Три кнопки этапа подписания (решение 2026-08-25): «Подписать»,
        // «Вернуть на доработку», «Отклонить» — одна панель для under_review /
        // pending_signature / awaiting_signatures.
        <div className={styles.actionsBar}>
          <Button variant="primary" block loading={signing} disabled={anyPending || signBlocked} onClick={() => void onSign()} data-testid="sign-cta">
            {t('signing.signCta')}
          </Button>
          {B2B_SIGNING_ROUTING && mySigReq?.status === 'pending' ? (
            <Button variant="ghost" loading={forward.isPending} disabled={anyPending} onClick={() => void onForward()}>
              {t('signing.realForwardCta')}
            </Button>
          ) : null}
          {/* Под согласованием договор и так на доработке — комментарий
              оставляют на карточке (протокол разногласий); `return_for_revision`
              бэк принимает только из заморозки (ADR-124). */}
          <Button variant="secondary" block disabled={anyPending} onClick={() => (underReview ? navigate(`/contracts/${id}`) : setReturnOpen(true))} data-testid="return-for-revision">
            {t('signing.realDeclineCta')}
          </Button>
          <Button variant="destructive" block disabled={anyPending} onClick={() => setRejectOpen(true)} data-testid="reject-cta">
            {t('signing.rejectCta')}
          </Button>
        </div>
      ) : null}

      {version ? (
        <Ceremony
          open={ceremonyOpen}
          title={t('signing.ceremonyTitle')}
          subtitle={t('signing.ceremonySubtitle', { title: contract.title || t('contracts.titleUnset') })}
          doneLabel={t('signing.ceremonyDone')}
          /* Строка сторон «контрагент ↔ вы · роль» (DEV-20_2 §9). */
          parties={
            myRole ? (
              <span data-testid="ceremony-parties">
                {ceremonyCounterpartyQ.data?.display_name ?? t('reputation.nameHidden')}
                {' ↔ '}
                {t(myRole === 'customer' ? 'contract.card.viewerRoleCustomer' : 'contract.card.viewerRoleContractor')}
              </span>
            ) : undefined
          }
          eyebrow={t('signing.ceremonyEyebrow')}
          facts={[
            { label: t('signing.ceremonyTimestamp'), value: formatDateTime(version.trusted_timestamp_at ?? version.frozen_at, { legal: true }) },
            { label: t('signing.ceremonyHash'), value: hashShort, accent: true },
          ]}
          /* «Скачать PDF» с эталона не подключаем: PDF-отчёт архива ещё
             «скоро» (`archive.formatPdfSoon`), поэтому второе действие ведёт
             туда, где документы реально забирают, — на экспорт архива. */
          secondaryLabel={t('contracts.actionExportArchive')}
          onSecondary={() => navigate(`/contracts/${id}/archive`)}
          onDone={() => navigate(`/contracts/${id}`)}
        />
      ) : null}

      <Modal
        open={returnOpen}
        title={t('signing.realDeclineCta')}
        onClose={() => setReturnOpen(false)}
        closeLabel={t('common.close')}
        actions={
          <>
            <Button variant="ghost" onClick={() => setReturnOpen(false)}>{t('common.cancel')}</Button>
            <Button variant="secondary" onClick={() => void onConfirmReturn()} loading={returnForRevision.isPending} disabled={!returnComment.trim()}>
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
        />
      </Modal>

      {/* Подпись кнопки одна («Отклонить», ADR-124 — для человека это один
          жест «не буду заключать»), но последствие называем точно: инициатор
          отзывает договор, вторая сторона отклоняет. */}
      <Modal
        open={rejectOpen}
        title={t(isInitiator ? 'signing.withdrawConfirmTitle' : 'signing.rejectConfirmTitle')}
        onClose={() => setRejectOpen(false)}
        closeLabel={t('common.close')}
        actions={
          <>
            <Button variant="ghost" onClick={() => setRejectOpen(false)}>{t('common.cancel')}</Button>
            <Button variant="destructive" onClick={() => void onConfirmReject()} loading={reject.isPending || withdraw.isPending} data-testid="reject-confirm">
              {t('signing.rejectCta')}
            </Button>
          </>
        }
      >
        <p>{t(isInitiator ? 'signing.withdrawConfirmText' : 'signing.rejectConfirmText')}</p>
      </Modal>
    </div>
  );
}
