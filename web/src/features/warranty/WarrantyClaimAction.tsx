import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { ApiError } from '@porukam/core';
import { Button, Callout, EvidenceUploader, Modal, TextArea } from '@porukam/ui';
import { useSubmitWarrantyClaim } from '../disputes/api';
import { disputeErrorCode, disputeErrorKey } from '../disputes/errorText';
import { useRealContractMilestones } from '../contracts/realApi';
import { leavesOf } from '../contracts/milestoneView';
import { useUploadRealEvidence } from '../stageExecution/realApi';
import styles from './WarrantyClaimAction.module.css';

export interface WarrantyClaimActionProps {
  contractId: string;
  /** `true` — рисуем кнопку во всю ширину (колонка действий паспорта). */
  block?: boolean;
}

/**
 * «Гарантийная претензия» на карточке договора в статусе `warranty`
 * (ADR-029/030, ADR-131 §7). Претензию подаёт ЗАКАЗЧИК и только пока идёт
 * гарантийный период — оба правила держит бэк (`403 wrong_dispute_side`,
 * `422 warranty_period_not_active`), экран печатает их текстом у кнопки.
 *
 * Успех уводит в РАЗНОГЛАСИЕ (`dispute_id`): претензия открывает
 * `Dispute(kind=warranty)`, и весь дальнейший диалог идёт там — отдельного
 * экрана претензии нет и не нужно.
 *
 * ХВОСТ БЭКА (см. отчёт по ветке): контрактного эндпоинта загрузки
 * доказательства нет — `apps.evidence` принимает файл только с привязкой к
 * ЭТАПУ либо к уже существующему СПОРУ (`EvidenceNotAttachedError`), а
 * претензия требует непустой `evidence` ДО того, как спор создан. Пока это
 * так, файл уходит на последний лист договора: договор, загрузивший
 * пользователь и доверенная метка времени верные, приблизительна только
 * привязка к этапу. Правильное решение — `POST /contracts/{id}/evidence`
 * либо приём претензии без доказательства с дозагрузкой в открытый спор.
 */
export function WarrantyClaimAction({ contractId, block }: WarrantyClaimActionProps): JSX.Element {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [description, setDescription] = useState('');
  const [picked, setPicked] = useState<{ id: string; name: string }[]>([]);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [err, setErr] = useState<unknown>(null);

  const milestonesQ = useRealContractMilestones(contractId);
  const leaves = leavesOf(milestonesQ.data ?? []);
  const anchorMilestoneId = leaves.at(-1)?.id;
  const upload = useUploadRealEvidence(anchorMilestoneId);
  const submit = useSubmitWarrantyClaim(contractId);

  function close(): void {
    setOpen(false);
    setDescription('');
    setPicked([]);
    setUploadError(null);
    setErr(null);
  }

  async function onSelectFiles(files: File[]): Promise<void> {
    setUploadError(null);
    if (!anchorMilestoneId) {
      setUploadError(t('dispute.warrantyNoAnchor'));
      return;
    }
    for (const file of files) {
      try {
        const evidence = await upload.mutateAsync({ file });
        setPicked((prev) => [...prev, { id: evidence.id, name: evidence.file_name }]);
      } catch (e) {
        setUploadError(e instanceof ApiError ? (e.problem.title || e.code || t('dispute.errorUnknown')) : String(e));
      }
    }
  }

  async function onSubmit(): Promise<void> {
    setErr(null);
    try {
      const claim = await submit.mutateAsync({ description, evidence: picked.map((p) => p.id) });
      close();
      if (claim.dispute_id) navigate(`/disputes/${claim.dispute_id}`);
    } catch (e) {
      setErr(e);
    }
  }

  const key = disputeErrorKey(err);
  const title = err instanceof ApiError ? err.problem.title : undefined;
  const errText = err
    ? key
      ? t(key)
      : title && title !== disputeErrorCode(err)
        ? title
        : t('dispute.errorUnknown')
    : null;

  const canSubmit = description.trim().length > 0 && picked.length > 0;

  return (
    <>
      <Button variant="secondary" block={block} onClick={() => setOpen(true)} data-testid="warranty-claim-open">
        {t('dispute.warrantyClaimAction')}
      </Button>
      <Modal
        open={open}
        title={t('dispute.warrantyClaimTitle')}
        onClose={close}
        closeLabel={t('common.close')}
        actions={
          <>
            <Button variant="ghost" onClick={close}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="primary"
              disabled={!canSubmit}
              loading={submit.isPending}
              onClick={() => void onSubmit()}
              data-testid="warranty-claim-submit"
            >
              {t('dispute.warrantyClaimSubmit')}
            </Button>
          </>
        }
      >
        <div className={styles.form}>
          <TextArea
            label={t('dispute.warrantyDescriptionLabel')}
            hint={t('dispute.warrantyDescriptionHint')}
            required
            rows={4}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            data-testid="warranty-claim-description"
          />
          <EvidenceUploader
            dropLabel={t('dispute.evidenceDrop')}
            browseLabel={t('dispute.evidenceBrowse')}
            bindLabel=""
            bindHint=""
            bindOptions={[]}
            bindValue=""
            onBindChange={() => undefined}
            onSelectFiles={(files) => void onSelectFiles(files)}
            uploading={upload.isPending}
            uploadingLabel={t('dispute.evidenceUploading')}
            cameraStubText={t('dispute.evidenceCameraStub')}
            errorText={uploadError ?? undefined}
            dismissErrorLabel={t('common.close')}
            onDismissError={() => setUploadError(null)}
          />
          {picked.length > 0 ? (
            <ul className={styles.picked} data-testid="warranty-claim-evidence">
              {picked.map((p) => (
                <li key={p.id}>{p.name}</li>
              ))}
            </ul>
          ) : (
            <p className={styles.note}>{t('dispute.warrantyEvidenceRequired')}</p>
          )}
          {errText ? (
            <Callout tone="warn" title={t('dispute.errorActionTitle')}>
              <span data-testid="warranty-claim-error">{errText}</span>
            </Callout>
          ) : null}
        </div>
      </Modal>
    </>
  );
}
