import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { ApiError, type ContractRole, type Dispute, type DisputeApiResolutionType, type WarrantyClaim } from '@porukam/core';
import { Button, Callout, EvidenceUploader, Modal, MoneyField, TextArea } from '@porukam/ui';
import { WIZARD_CURRENCIES } from '../contractNew/currencies';
import {
  useDeclineDiscount,
  useDisputeEvidence,
  useProposeDiscount,
  useRequestFix,
  useResolveDispute,
  useRespondToDispute,
  useResubmitFix,
  useUploadDisputeEvidence,
} from './api';
import { disputeErrorCode, disputeErrorKey } from './errorText';
import { WarrantyClaimActions } from '../warranty/WarrantyClaimActions';
import { useFormatters } from '../../shared/formatters';
import styles from '../../pages/DisputePage.module.css';

export const MAX_FIX_ROUNDS = 2;

export interface DisputeActionsProps {
  dispute: Dispute;
  /** Роль ЧИТАТЕЛЯ (обратная `counterparty.role`); `null` — вторую сторону
   * бэк не отдал, роль неизвестна. */
  myRole: ContractRole | null;
  /** `users/me.id` — `opened_by_id` это идентификатор ПОЛЬЗОВАТЕЛЯ, не профиля. */
  myUserId: string | undefined;
  /** Сумма спорного листа — для формы скидки (валюта обязательна отдельно). */
  milestoneAmount?: { amount: string; currency: string } | null;
  /** Гарантийная претензия спора `kind=warranty` (ADR-133) — её действия
   * («устранил» / «удовлетворена» / «не устранено» / «отказать») заменяют
   * общее «Закрыть по согласию»: исход претензии и есть исход спора. */
  claim?: WarrantyClaim | null;
}

type OpenForm = 'respond' | 'fix' | 'resubmit' | 'discount' | null;
type Confirm = 'consent' | 'court' | null;

/**
 * Панель действий по разногласию (ADR-131 §1: FSM `open` → `awaiting_fix` →
 * `open` → `awaiting_discount` → `resolved`).
 *
 * Кнопка показывается ровно там, где переход ОБЪЯВЛЕН, и ровно той стороне,
 * которой он разрешён: раунд исправления просит заказчик, сдаёт исполнитель,
 * отвечает — не тот, кто открыл спор. Роль читателя выводим из
 * `counterparty.role` (она относительна читателю), при неизвестной роли
 * кнопку не прячем — последнее слово всё равно за бэком (403
 * `wrong_dispute_side`), а молча спрятанное действие человек не найдёт.
 *
 * Исключение — «Запросить исправление» на 2/2: кнопка остаётся ВИДИМОЙ и
 * гаснет с пояснением, потому что «кнопка исчезла» и «раунды кончились» для
 * человека разные факты (первое читается как поломка).
 */
export function DisputeActions({ dispute, myRole, myUserId, milestoneAmount, claim }: DisputeActionsProps): JSX.Element | null {
  const { t } = useTranslation();
  // Деньги — только через `formatMoney` (web/CLAUDE.md §2 п.3): сырое
  // «45000.00 RUB» из API человеку не показываем.
  const { formatMoney } = useFormatters();
  const [open, setOpen] = useState<OpenForm>(null);
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [err, setErr] = useState<unknown>(null);
  const [comment, setComment] = useState('');
  const [newAmount, setNewAmount] = useState('');
  // Валюта СПОРНОГО ЛИСТА, а не свободный выбор: скидка возможна только в
  // валюте этапа (иначе `422 discount_not_applicable`). `useState` с ней в
  // качестве начального значения не годится — сумма листа приходит вторым
  // запросом, и поле навсегда осталось бы пустым; поэтому значение считается
  // на каждый рендер, а ручная правка живёт отдельным override.
  const [currencyOverride, setCurrencyOverride] = useState<string | null>(null);
  const [antiWaiver, setAntiWaiver] = useState('');
  const [reason, setReason] = useState('');
  const [pickedEvidence, setPickedEvidence] = useState<{ id: string; name: string }[]>([]);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [newAmendmentId, setNewAmendmentId] = useState<string | null>(null);

  const evidenceQ = useDisputeEvidence(dispute.id);
  const uploadEvidence = useUploadDisputeEvidence(dispute.id);
  const respond = useRespondToDispute(dispute.id);
  const requestFix = useRequestFix(dispute.id);
  const resubmitFix = useResubmitFix(dispute.id);
  const proposeDiscount = useProposeDiscount(dispute.id);
  const declineDiscount = useDeclineDiscount(dispute.id);
  const resolve = useResolveDispute(dispute.id);

  const resolved = dispute.status === 'resolved';
  const isMilestone = dispute.kind === 'milestone';
  const iOpened = !!myUserId && myUserId === dispute.opened_by_id;
  const roleAllows = (role: ContractRole) => myRole === null || myRole === role;

  // Открытый (несданный) раунд исправления — цель «Сдать исправление».
  const openFixRequest = dispute.fix_requests.find((fr) => fr.resubmitted_at === null);
  // Предложение скидки, по которому ждут решения ВТОРОЙ стороны.
  const pendingDiscount = dispute.discount_agreements.find((d) => d.status === 'proposed');
  const canDeclineDiscount =
    !!pendingDiscount && dispute.status === 'awaiting_discount' && (!myUserId || pendingDiscount.proposed_by_id !== myUserId);

  const showRequestFix = !resolved && isMilestone && dispute.status === 'open' && roleAllows('customer');
  const showResubmit = !resolved && isMilestone && dispute.status === 'awaiting_fix' && !!openFixRequest && roleAllows('contractor');
  const showRespond = !resolved && !iOpened;
  const showDiscount =
    !resolved && isMilestone && (dispute.status === 'open' || dispute.status === 'awaiting_fix') && !!milestoneAmount;
  const fixRoundsExhausted = dispute.fix_rounds_left <= 0;

  if (resolved) return null;

  function closeForm(): void {
    setOpen(null);
    setConfirm(null);
    setErr(null);
    setComment('');
    setNewAmount('');
    setCurrencyOverride(null);
    setAntiWaiver('');
    setReason('');
    setPickedEvidence([]);
    setUploadError(null);
  }

  /** Ошибку действия печатаем ПО КОДУ (`dispute.error*`), с откатом на
   * `problem.title` бэка — он приходит на языке запроса (ADR-119). */
  function errorNode(): JSX.Element | null {
    if (!err) return null;
    const key = disputeErrorKey(err);
    const title = err instanceof ApiError ? err.problem.title : undefined;
    const text = key ? t(key) : title && title !== disputeErrorCode(err) ? title : t('dispute.errorUnknown');
    return (
      <Callout tone="warn" title={t('dispute.errorActionTitle')}>
        <span data-testid="dispute-action-error">{text}</span>
      </Callout>
    );
  }

  async function run(fn: () => Promise<unknown>, after?: () => void): Promise<void> {
    setErr(null);
    try {
      await fn();
      after ? after() : closeForm();
    } catch (e) {
      setErr(e);
    }
  }

  async function onUploadFiles(files: File[]): Promise<void> {
    setUploadError(null);
    for (const file of files) {
      try {
        const evidence = await uploadEvidence.mutateAsync({ file });
        setPickedEvidence((prev) => [...prev, { id: evidence.id, name: evidence.file_name }]);
      } catch (e) {
        setUploadError(e instanceof ApiError ? (e.problem.title || e.code || t('dispute.errorUnknown')) : String(e));
      }
    }
  }

  const alreadyUploaded = (evidenceQ.data ?? []).length;
  // «Закрыть по согласию» — это РАЗНЫЙ код исхода у разногласия по этапу и у
  // гарантийного: `apps.warranty.handlers` переносит `resolution_type` в
  // заявку, и `accepted` вместо `warranty_satisfied` испортил бы отдельную
  // гарантийную метрику (ADR-030). `warranty_declined` входа в UI пока не
  // имеет — отказ по претензии это не «закрытие по согласию».
  const consentResolution: DisputeApiResolutionType = dispute.kind === 'warranty' ? 'warranty_satisfied' : 'accepted';
  const currency = currencyOverride ?? milestoneAmount?.currency ?? '';
  // У претензии с контуром устранения (ADR-133) «закрыть по согласию» —
  // это «удовлетворена» заказчика либо «отказать» исполнителя: общая кнопка
  // дала бы второй, обезличенный путь к тому же исходу.
  const warrantyClaim = dispute.kind === 'warranty' ? claim ?? null : null;
  const showConsent = !warrantyClaim;

  return (
    <div className={styles.actions} data-testid="dispute-actions">
      {warrantyClaim ? <WarrantyClaimActions dispute={dispute} claim={warrantyClaim} myRole={myRole} /> : null}
      {showRequestFix ? (
        <Button
          variant="outline"
          block
          disabled={fixRoundsExhausted}
          onClick={() => setOpen('fix')}
          data-testid="dispute-request-fix"
        >
          {t('dispute.actionRequestFix')}
        </Button>
      ) : null}
      {showResubmit ? (
        <Button variant="primary" block onClick={() => setOpen('resubmit')} data-testid="dispute-resubmit-fix">
          {t('dispute.actionResubmitFix')}
        </Button>
      ) : null}
      {showRespond ? (
        <Button variant="primary" block onClick={() => setOpen('respond')} data-testid="dispute-respond">
          {t('dispute.actionRespond')}
        </Button>
      ) : null}
      {showDiscount ? (
        <Button
          variant="outline"
          block
          // Оговорка об объёме обязательна (ADR-131 §3), но сочинять её заново
          // человек не должен: кладём в поле рекомендуемую формулировку на
          // языке интерфейса — правится как обычный текст.
          onClick={() => {
            setAntiWaiver(t('dispute.antiWaiverDefault'));
            setOpen('discount');
          }}
          data-testid="dispute-propose-discount"
        >
          {t('dispute.actionProposeDiscount')}
        </Button>
      ) : null}
      {canDeclineDiscount ? (
        <Button
          variant="outline"
          block
          loading={declineDiscount.isPending}
          onClick={() => void run(() => declineDiscount.mutateAsync({ agreementId: pendingDiscount.id }))}
          data-testid="dispute-decline-discount"
        >
          {t('dispute.actionDeclineDiscount')}
        </Button>
      ) : null}
      {showConsent ? (
        <Button variant="outline" block onClick={() => setConfirm('consent')} data-testid="dispute-resolve-accepted">
          {t('dispute.actionResolveAccepted')}
        </Button>
      ) : null}
      <Button variant="outline-danger" block onClick={() => setConfirm('court')} data-testid="dispute-resolve-court">
        {t('dispute.actionResolveCourt')}
      </Button>

      {/* Пояснение к погашенной кнопке живёт РЯДОМ с ней, а не в модалке:
          человек должен понять «почему нельзя» не нажимая (ADR-131 §2). */}
      {showRequestFix && fixRoundsExhausted ? (
        <Callout tone="neutral" title={t('dispute.fixRoundsExhaustedTitle')}>
          <span data-testid="dispute-fix-rounds-exhausted">{t('dispute.fixRoundsExhaustedText')}</span>
        </Callout>
      ) : null}

      {!open && !confirm ? errorNode() : null}

      <Modal
        open={open === 'fix'}
        title={t('dispute.actionRequestFix')}
        onClose={closeForm}
        closeLabel={t('common.close')}
        actions={
          <>
            <Button variant="ghost" onClick={closeForm}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="primary"
              loading={requestFix.isPending}
              onClick={() => void run(() => requestFix.mutateAsync({ comment }))}
              data-testid="dispute-request-fix-submit"
            >
              {t('dispute.actionRequestFix')}
            </Button>
          </>
        }
      >
        <div className={styles.form}>
          <p className={styles.formNote}>
            {t('dispute.fixRoundsLeft', { left: dispute.fix_rounds_left, max: MAX_FIX_ROUNDS })}
          </p>
          <TextArea
            label={t('dispute.commentLabel')}
            rows={4}
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            data-testid="dispute-fix-comment"
          />
          {errorNode()}
        </div>
      </Modal>

      <Modal
        open={open === 'resubmit'}
        title={t('dispute.actionResubmitFix')}
        onClose={closeForm}
        closeLabel={t('common.close')}
        actions={
          <>
            <Button variant="ghost" onClick={closeForm}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="primary"
              loading={resubmitFix.isPending}
              onClick={() =>
                openFixRequest
                  ? void run(() => resubmitFix.mutateAsync({ fixRequestId: openFixRequest.id, comment }))
                  : undefined
              }
              data-testid="dispute-resubmit-fix-submit"
            >
              {t('dispute.actionResubmitFix')}
            </Button>
          </>
        }
      >
        <div className={styles.form}>
          <p className={styles.formNote}>{t('dispute.resubmitNote')}</p>
          <TextArea
            label={t('dispute.commentLabel')}
            rows={4}
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            data-testid="dispute-resubmit-comment"
          />
          {errorNode()}
        </div>
      </Modal>

      <Modal
        open={open === 'respond'}
        title={t('dispute.actionRespond')}
        onClose={closeForm}
        closeLabel={t('common.close')}
        actions={
          <>
            <Button variant="ghost" onClick={closeForm}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="primary"
              loading={respond.isPending}
              onClick={() =>
                void run(() => respond.mutateAsync({ comment, evidence: pickedEvidence.map((e) => e.id) }))
              }
              data-testid="dispute-respond-submit"
            >
              {t('dispute.actionRespond')}
            </Button>
          </>
        }
      >
        <div className={styles.form}>
          <TextArea
            label={t('dispute.commentLabel')}
            rows={4}
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            data-testid="dispute-respond-comment"
          />
          {/* Тот же загрузчик, что на экране этапа (DEV-11 §3/§4); привязки к
              пункту чек-листа здесь нет — эндпоинт разногласия её не принимает,
              поэтому список опций пуст и селектор не рисуется. */}
          <EvidenceUploader
            dropLabel={t('dispute.evidenceDrop')}
            browseLabel={t('dispute.evidenceBrowse')}
            bindLabel=""
            bindHint=""
            bindOptions={[]}
            bindValue=""
            onBindChange={() => undefined}
            onSelectFiles={(files) => void onUploadFiles(files)}
            uploading={uploadEvidence.isPending}
            uploadingLabel={t('dispute.evidenceUploading')}
            cameraStubText={t('dispute.evidenceCameraStub')}
            errorText={uploadError ?? undefined}
            dismissErrorLabel={t('common.close')}
            onDismissError={() => setUploadError(null)}
          />
          {pickedEvidence.length > 0 ? (
            <ul className={styles.evidencePicked} data-testid="dispute-respond-evidence">
              {pickedEvidence.map((e) => (
                <li key={e.id}>{e.name}</li>
              ))}
            </ul>
          ) : (
            <p className={styles.formNote}>{t('dispute.evidenceAlready', { count: alreadyUploaded })}</p>
          )}
          {errorNode()}
        </div>
      </Modal>

      <Modal
        open={open === 'discount'}
        title={t('dispute.discountTitle')}
        onClose={closeForm}
        closeLabel={t('common.close')}
        actions={
          newAmendmentId ? (
            <Button variant="ghost" onClick={closeForm}>
              {t('common.close')}
            </Button>
          ) : (
            <>
              <Button variant="ghost" onClick={closeForm}>
                {t('common.cancel')}
              </Button>
              <Button
                variant="primary"
                loading={proposeDiscount.isPending}
                onClick={() =>
                  void run(
                    async () => {
                      const agreement = await proposeDiscount.mutateAsync({
                        new_amount: newAmount,
                        currency,
                        anti_waiver_note: antiWaiver,
                        reason,
                      });
                      setNewAmendmentId(agreement.amendment_id);
                    },
                    () => undefined,
                  )
                }
                data-testid="dispute-discount-submit"
              >
                {t('dispute.actionProposeDiscount')}
              </Button>
            </>
          )
        }
      >
        <div className={styles.form}>
          {newAmendmentId ? (
            <>
              <Callout tone="info" title={t('dispute.discountCreatedTitle')}>
                {t('dispute.discountCreatedText')}
              </Callout>
              {/* Принятие скидки — ПОДПИСЬ допника общим контуром §8.6
                  (ADR-131 §3), поэтому здесь ссылка, а не вторая кнопка
                  «принять»: два источника правды о том, вступила ли скидка в
                  силу, разошлись бы на первой же ошибке доставки. */}
              <Link
                to={`/contracts/${dispute.contract_id}/amendments/${newAmendmentId}`}
                data-testid="dispute-discount-amendment-link"
              >
                {t('dispute.discountSignLink')}
              </Link>
            </>
          ) : (
            <>
              {milestoneAmount ? (
                <p className={styles.formNote}>
                  {t('dispute.discountCurrentAmount', { amount: formatMoney(milestoneAmount) })}
                </p>
              ) : null}
              <MoneyField
                label={t('dispute.discountNewAmountLabel')}
                amount={newAmount}
                currency={currency}
                // Без явного списка MoneyField предлагает только RUB/USD/EUR, и
                // валюта договора (тенге, донги, реалы) в селекторе отсутствует.
                currencies={[...WIZARD_CURRENCIES]}
                onAmountChange={setNewAmount}
                onCurrencyChange={setCurrencyOverride}
                amountAriaLabel={t('dispute.discountNewAmountLabel')}
                currencyAriaLabel={t('common.currencyAriaLabel')}
                currencyPlaceholder={t('common.currencyPlaceholder')}
                hint={t('dispute.discountAmountHint')}
              />
              <TextArea
                label={t('dispute.antiWaiverLabel')}
                hint={t('dispute.antiWaiverHint')}
                required
                rows={3}
                value={antiWaiver}
                onChange={(e) => setAntiWaiver(e.target.value)}
                data-testid="dispute-discount-anti-waiver"
              />
              <TextArea
                label={t('dispute.discountReasonLabel')}
                rows={2}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                data-testid="dispute-discount-reason"
              />
              {errorNode()}
            </>
          )}
        </div>
      </Modal>

      <Modal
        open={confirm !== null}
        title={confirm === 'court' ? t('dispute.actionResolveCourt') : t('dispute.actionResolveAccepted')}
        onClose={closeForm}
        closeLabel={t('common.close')}
        actions={
          <>
            <Button variant="ghost" onClick={closeForm}>
              {t('common.cancel')}
            </Button>
            <Button
              variant={confirm === 'court' ? 'destructive' : 'primary'}
              loading={resolve.isPending}
              onClick={() =>
                confirm
                  ? void run(() =>
                      resolve.mutateAsync({
                        resolutionType: confirm === 'court' ? 'escalated_to_court' : consentResolution,
                      }),
                    )
                  : undefined
              }
              data-testid="dispute-resolve-confirm"
            >
              {t('dispute.actionConfirm')}
            </Button>
          </>
        }
      >
        <div className={styles.form}>
          <p className={styles.formNote}>
            {confirm === 'court' ? t('dispute.resolveCourtConfirm') : t('dispute.resolveAcceptedConfirm')}
          </p>
          {errorNode()}
        </div>
      </Modal>
    </div>
  );
}
