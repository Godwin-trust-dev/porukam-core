import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError, type ContractRole, type Dispute, type WarrantyClaim } from '@porukam/core';
import { Button, Callout, EvidenceUploader, Modal, TextArea } from '@porukam/ui';
import {
  useContestWarrantyFix,
  useDeclineWarrantyClaim,
  useSatisfyWarrantyClaim,
  useSubmitWarrantyFix,
  useUploadDisputeEvidence,
} from '../disputes/api';
import { MAX_FIX_ROUNDS } from '../disputes/DisputeActions';
import { disputeErrorCode, disputeErrorKey } from '../disputes/errorText';
import styles from '../../pages/DisputePage.module.css';

export interface WarrantyClaimActionsProps {
  dispute: Dispute;
  claim: WarrantyClaim;
  /** Роль читателя (из `counterparty.role`); `null` — неизвестна, кнопки не прячем. */
  myRole: ContractRole | null;
}

type OpenForm = 'fix' | 'decline' | 'satisfy' | 'contest' | null;

/** Коды, у которых в контуре ПРЕТЕНЗИИ свой текст: «раунды исчерпаны» у
 * спора по этапу советует скидку, у гарантии скидки нет. */
const CLAIM_CODE_KEY: Record<string, string> = {
  fix_rounds_exhausted: 'dispute.errorWarrantyFixRoundsExhausted',
};

/**
 * Действия по гарантийной претензии на карточке спора `kind=warranty`
 * (ADR-133, решение владельца: подтверждает ЗАКАЗЧИК, симметрично отказу
 * исполнителя; контур — как приёмка этапа).
 *
 *   исполнитель, `submitted`:               «Устранил» → `fix-submitted`
 *   исполнитель, любой открытый:            «Отказать» → `decline`
 *   заказчик,    любой открытый:            «Удовлетворена» → `satisfy` («сделали на месте» — тоже)
 *   заказчик,    `awaiting_confirmation`:   «Не устранено» → `contest`
 *   молчание заказчика в окне — автоподтверждение по свипу (кнопки нет).
 *
 * Потолок — на ВОЗРАЖЕНИЯ заказчика (`fix_rounds_left`, как раунды спора по
 * этапу): на 0 «Не устранено» остаётся видимой и гаснет с пояснением —
 * «кнопка исчезла» читается как поломка, «раунды кончились» — как факт
 * (ADR-131 §2).
 */
export function WarrantyClaimActions({ dispute, claim, myRole }: WarrantyClaimActionsProps): JSX.Element | null {
  const { t } = useTranslation();
  const [open, setOpen] = useState<OpenForm>(null);
  const [comment, setComment] = useState('');
  const [err, setErr] = useState<unknown>(null);
  const [picked, setPicked] = useState<{ id: string; name: string }[]>([]);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const ref = { claimId: claim.id, disputeId: dispute.id, contractId: dispute.contract_id };
  const uploadEvidence = useUploadDisputeEvidence(dispute.id);
  const submitFix = useSubmitWarrantyFix(ref);
  const decline = useDeclineWarrantyClaim(ref);
  const satisfy = useSatisfyWarrantyClaim(ref);
  const contest = useContestWarrantyFix(ref);

  if (dispute.status === 'resolved' || claim.status === 'resolved') return null;

  const roleAllows = (role: ContractRole) => myRole === null || myRole === role;
  const roundsLeft = claim.fix_rounds_left ?? Math.max(MAX_FIX_ROUNDS - (claim.fix_rounds_used ?? 0), 0);
  const roundsExhausted = roundsLeft <= 0;
  const showFix = claim.status === 'submitted' && roleAllows('contractor');
  const showDecline = roleAllows('contractor');
  const showSatisfy = roleAllows('customer');
  const showContest = claim.status === 'awaiting_confirmation' && roleAllows('customer');

  function closeForm(): void {
    setOpen(null);
    setErr(null);
    setComment('');
    setPicked([]);
    setUploadError(null);
  }

  function errorNode(): JSX.Element | null {
    if (!err) return null;
    const code = disputeErrorCode(err);
    const key = (code ? CLAIM_CODE_KEY[code] : undefined) ?? disputeErrorKey(err);
    const title = err instanceof ApiError ? err.problem.title : undefined;
    const text = key ? t(key) : title && title !== code ? title : t('dispute.errorUnknown');
    return (
      <Callout tone="warn" title={t('dispute.errorActionTitle')}>
        <span data-testid="warranty-action-error">{text}</span>
      </Callout>
    );
  }

  async function run(fn: () => Promise<unknown>): Promise<void> {
    setErr(null);
    try {
      await fn();
      closeForm();
    } catch (e) {
      setErr(e);
    }
  }

  async function onUploadFiles(files: File[]): Promise<void> {
    setUploadError(null);
    for (const file of files) {
      try {
        const evidence = await uploadEvidence.mutateAsync({ file });
        setPicked((prev) => [...prev, { id: evidence.id, name: evidence.file_name }]);
      } catch (e) {
        setUploadError(e instanceof ApiError ? (e.problem.title || e.code || t('dispute.errorUnknown')) : String(e));
      }
    }
  }

  const uploader = (
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
  );
  const pickedList =
    picked.length > 0 ? (
      <ul className={styles.evidencePicked} data-testid="warranty-picked-evidence">
        {picked.map((e) => (
          <li key={e.id}>{e.name}</li>
        ))}
      </ul>
    ) : null;

  return (
    <div data-testid="warranty-claim-actions">
      {showFix ? (
        <Button variant="primary" block onClick={() => setOpen('fix')} data-testid="warranty-fix-submitted">
          {t('dispute.actionWarrantyFixSubmitted')}
        </Button>
      ) : null}
      {showSatisfy ? (
        <Button variant={claim.status === 'awaiting_confirmation' ? 'primary' : 'secondary'} block onClick={() => setOpen('satisfy')} data-testid="warranty-satisfy">
          {t('dispute.actionWarrantySatisfy')}
        </Button>
      ) : null}
      {showContest ? (
        <Button variant="secondary" block disabled={roundsExhausted} onClick={() => setOpen('contest')} data-testid="warranty-contest">
          {t('dispute.actionWarrantyContest')}
        </Button>
      ) : null}
      {showDecline ? (
        <Button variant="destructive" block onClick={() => setOpen('decline')} data-testid="warranty-decline">
          {t('dispute.actionWarrantyDecline')}
        </Button>
      ) : null}

      {showContest && roundsExhausted ? (
        <Callout tone="neutral" title={t('dispute.warrantyRoundsExhaustedTitle')}>
          <span data-testid="warranty-rounds-exhausted">{t('dispute.warrantyRoundsExhaustedText')}</span>
        </Callout>
      ) : null}

      {!open ? errorNode() : null}

      <Modal
        open={open === 'fix'}
        title={t('dispute.actionWarrantyFixSubmitted')}
        onClose={closeForm}
        closeLabel={t('common.close')}
        actions={
          <>
            <Button variant="ghost" onClick={closeForm}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="primary"
              loading={submitFix.isPending}
              onClick={() => void run(() => submitFix.mutateAsync({ comment, evidence: picked.map((e) => e.id) }))}
              data-testid="warranty-fix-submitted-submit"
            >
              {t('dispute.actionWarrantyFixSubmitted')}
            </Button>
          </>
        }
      >
        <div className={styles.form}>
          <p className={styles.formNote}>{t('dispute.warrantyFixNote')}</p>
          <TextArea
            label={t('dispute.commentLabel')}
            rows={4}
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            data-testid="warranty-fix-comment"
          />
          {uploader}
          {pickedList}
          {errorNode()}
        </div>
      </Modal>

      <Modal
        open={open === 'decline'}
        title={t('dispute.actionWarrantyDecline')}
        onClose={closeForm}
        closeLabel={t('common.close')}
        actions={
          <>
            <Button variant="ghost" onClick={closeForm}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="destructive"
              loading={decline.isPending}
              onClick={() => void run(() => decline.mutateAsync({ comment }))}
              data-testid="warranty-decline-submit"
            >
              {t('dispute.actionWarrantyDecline')}
            </Button>
          </>
        }
      >
        <div className={styles.form}>
          <p className={styles.formNote}>{t('dispute.warrantyDeclineNote')}</p>
          <TextArea
            label={t('dispute.commentLabel')}
            rows={4}
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            data-testid="warranty-decline-comment"
          />
          {errorNode()}
        </div>
      </Modal>

      <Modal
        open={open === 'satisfy'}
        title={t('dispute.actionWarrantySatisfy')}
        onClose={closeForm}
        closeLabel={t('common.close')}
        actions={
          <>
            <Button variant="ghost" onClick={closeForm}>
              {t('common.cancel')}
            </Button>
            <Button variant="primary" loading={satisfy.isPending} onClick={() => void run(() => satisfy.mutateAsync({ comment }))} data-testid="warranty-satisfy-confirm">
              {t('dispute.actionConfirm')}
            </Button>
          </>
        }
      >
        <div className={styles.form}>
          <p className={styles.formNote}>{t('dispute.warrantySatisfyConfirm')}</p>
          <TextArea
            label={t('dispute.commentLabel')}
            rows={3}
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            data-testid="warranty-satisfy-comment"
          />
          {errorNode()}
        </div>
      </Modal>

      <Modal
        open={open === 'contest'}
        title={t('dispute.actionWarrantyContest')}
        onClose={closeForm}
        closeLabel={t('common.close')}
        actions={
          <>
            <Button variant="ghost" onClick={closeForm}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="primary"
              loading={contest.isPending}
              disabled={!comment.trim()}
              onClick={() => void run(() => contest.mutateAsync({ comment, evidence: picked.map((e) => e.id) }))}
              data-testid="warranty-contest-submit"
            >
              {t('dispute.actionWarrantyContest')}
            </Button>
          </>
        }
      >
        <div className={styles.form}>
          <p className={styles.formNote}>{t('dispute.warrantyContestNote')}</p>
          <p className={styles.formNote}>{t('dispute.warrantyRoundsLeft', { left: roundsLeft, max: MAX_FIX_ROUNDS })}</p>
          <TextArea
            label={t('dispute.commentLabel')}
            required
            rows={4}
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            data-testid="warranty-contest-comment"
          />
          {uploader}
          {pickedList}
          {errorNode()}
        </div>
      </Modal>
    </div>
  );
}
