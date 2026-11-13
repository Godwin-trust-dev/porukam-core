import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ApiError, type AcceptanceRemark } from '@porukam/core';
import {
  Ceremony,
  ChecklistAcceptItem,
  Avatar,
  Button,
  Callout,
  EvidenceFiles,
  ErrorState,
  Icon,
  LtrText,
  Modal,
  PhotoViewer,
  Skeleton,
  WaitingSubmission,
  type ChecklistDecision,
  type EvidenceFile,
} from '@porukam/ui';
import { useAcceptanceApi, useMilestoneAcceptance } from '../features/acceptance/api';
import { useViewerStore } from '../features/contracts/viewerStore';
import { PageHead, cardCompactStyles as cc } from '../features/contracts/cardCompact/CardBlocks';
import { useFormatters } from '../shared/formatters';
import styles from './AcceptancePage.module.css';
import { isFeatureEnabled } from '../shared/features';
import { apiErrorText } from '../shared/apiErrorText';

interface Decision {
  value: ChecklistDecision | null;
  note: string;
  file: File | null;
}

/**
 * Приёмка этапа (DEV-04): `/contracts/:id/milestones/:mid/accept`. Роль —
 * заказчик (гейт §1). Искра — ТОЛЬКО в церемонии «Принято» (§2 CLAUDE.md,
 * приёмка 5 задания) — на кнопке её намеренно нет, хотя в макете упомянута.
 */
export function AcceptancePage(): JSX.Element {
  const { t } = useTranslation();
  const { formatMoney } = useFormatters();
  const navigate = useNavigate();
  const { id = '', mid = '' } = useParams();
  const viewAs = useViewerStore((s) => s.viewAs);
  const isCustomer = viewAs === 'customer';

  const { data, isPending, error, refetch } = useMilestoneAcceptance(id, mid, isCustomer);
  const api = useAcceptanceApi(id, mid);

  const [decisions, setDecisions] = useState<Record<string, Decision>>({});
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [ceremonyOpen, setCeremonyOpen] = useState(false);
  const [viewerFile, setViewerFile] = useState<EvidenceFile | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!data) return;
    setDecisions(Object.fromEntries(data.checklist.map((ci) => [ci.id, { value: null, note: '', file: null }])));
  }, [data?.milestoneId]);

  if (!isCustomer) {
    return (
      <div className={styles.wrap}>
        <Callout tone="warn" title={t('acceptance.gateTitle')}>
          <Button variant="ghost" onClick={() => useViewerStore.getState().setViewAs('customer')}>
            {t('acceptance.gateSwitch')}
          </Button>
        </Callout>
      </div>
    );
  }

  if (isPending) {
    return (
      <div className={styles.wrap}>
        <Skeleton width="60%" height={30} />
        <Skeleton width="100%" height={80} radius="var(--pr-r-lg)" />
        <Skeleton width="100%" height={200} radius="var(--pr-r-lg)" />
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className={styles.wrap}>
        <ErrorState
          title={t('acceptance.errorText')}
          text={apiErrorText(error)}
          code={error instanceof ApiError ? error.code : undefined}
          retryLabel={t('common.retry')}
          onRetry={() => void refetch()}
        />
      </div>
    );
  }

  const allAccepted = data.checklist.length > 0 && data.checklist.every((ci) => decisions[ci.id]?.value === 'accept');
  const remarkIds = data.checklist.filter((ci) => decisions[ci.id]?.value === 'remark');
  const hasRemark = remarkIds.length > 0;
  const allDecided = data.checklist.every((ci) => decisions[ci.id]?.value != null);
  const remarksComplete = remarkIds.every((ci) => decisions[ci.id]?.note.trim() && decisions[ci.id]?.file);
  const canReturn = hasRemark && allDecided && remarksComplete;

  async function confirmAccept(): Promise<void> {
    setConfirmOpen(false);
    try {
      await api.accept();
      setCeremonyOpen(true);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : String(e));
    }
  }

  async function submitReturn(): Promise<void> {
    setErr(null);
    const remarks: AcceptanceRemark[] = remarkIds.map((ci) => ({
      itemId: ci.id,
      note: decisions[ci.id]!.note.trim(),
      file: decisions[ci.id]!.file?.name,
    }));
    try {
      await api.returnWithRemarks(remarks);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : String(e));
    }
  }

  /* Доска B «Приёмка этапа»: «‹ Приёмка этапа» → название этапа → одна
     строка «сумма · контрагент». */
  const header = (
    <>
      <PageHead title={t('acceptance.title')} onBack={() => navigate(`/contracts/${id}`)} backLabel={t('common.back')} />
      <div className={styles.head}>
        <h1 className={styles.stage}>{data.stage}</h1>
        <div className={styles.meta}>
          <LtrText as="span" className={styles.metaSum}>
            {formatMoney(data.sum)}
          </LtrText>
          <span aria-hidden="true">·</span>
          <span className={styles.who}>
            <Avatar name={data.counterparty} size={20} />
            {data.counterparty}
          </span>
        </div>
      </div>
    </>
  );

  if (data.state === 'waiting') {
    return (
      <div className={styles.wrap}>
        {header}
        <WaitingSubmission
          scheduleLabel={
            data.planned?.delayDays != null
              ? t('acceptance.waitingDelayed', { days: data.planned.delayDays })
              : t('acceptance.waitingPlanned', { days: data.planned?.daysLeft ?? 0 })
          }
          tone={data.planned?.delayDays != null ? 'delayed' : 'planned'}
          chatLabel={t('acceptance.waitingChat')}
          onChat={isFeatureEnabled('chat') ? () => navigate('/chat') : undefined}
        />
      </div>
    );
  }

  if (data.state === 'auto_accepted') {
    return (
      <div className={styles.wrap}>
        {header}
        <div className={styles.centeredState}>
          <Icon name="checklist" size={48} />
          <Callout tone="neutral" title={t('acceptance.autoAcceptedTitle')}>
            {t('acceptance.autoAcceptedText')}
          </Callout>
          <Button variant="ghost" onClick={() => navigate('/disputes')}>
            {t('acceptance.autoAcceptedRestore')}
          </Button>
        </div>
      </div>
    );
  }

  if (data.state === 'returned') {
    return (
      <div className={styles.wrap}>
        {header}
        <Callout tone="warn" title={t('acceptance.returnedTitle')}>
          {t('acceptance.returnedText')}
        </Callout>
        <div className={styles.remarksList}>
          {data.remarks.map((r) => (
            <p className={styles.remarkItem} key={r.itemId}>
              {data.checklist.find((ci) => ci.id === r.itemId)?.label ?? r.itemId}: {r.note}
            </p>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className={styles.wrap}>
      {header}
      {err ? <Callout tone="warn">{err}</Callout> : null}

      {/* Таймер автоприёмки — одна компактная строка, не карточка (доска B). */}
      {data.timer ? (
        <p className={styles.timerLine} data-testid="acceptance-timer">
          <Icon name="calendar" size={16} />
          <b>{t('acceptance.timerValue', { hours: data.timer.hoursLeft })}</b>
          <span aria-hidden="true">·</span>
          {t('acceptance.timerHint')}
        </p>
      ) : null}

      {/* Чек-лист — заголовок + hairline-строки: чекбокс (teal при принятии),
          текст пункта, справа текстовая «Замечание». Никаких рамок на пункт. */}
      <section className={styles.card}>
        <h3 className={styles.sectionTitle}>{t('acceptance.checklistTitle')}</h3>
        <div className={styles.rows} data-testid="acceptance-checklist">
          {data.checklist.map((ci) => (
            <ChecklistAcceptItem
              key={ci.id}
              label={ci.label}
              value={decisions[ci.id]?.value ?? null}
              onChange={(value) => setDecisions((d) => ({ ...d, [ci.id]: { ...d[ci.id]!, value } }))}
              note={decisions[ci.id]?.note ?? ''}
              onNoteChange={(note) => setDecisions((d) => ({ ...d, [ci.id]: { ...d[ci.id]!, note } }))}
              onFileChange={(file) => setDecisions((d) => ({ ...d, [ci.id]: { ...d[ci.id]!, file } }))}
              attachedFileName={decisions[ci.id]?.file?.name}
              acceptLabel={t('acceptance.itemAccept')}
              remarkLabel={t('acceptance.itemRemark')}
              notePlaceholder={t('acceptance.notePlaceholder')}
              attachLabel={t('acceptance.attachLabel')}
              groupLabel={t('acceptance.itemGroupLabel')}
            />
          ))}
        </div>
      </section>

      <div className={styles.card}>
        <h3 className={styles.sectionTitle}>{t('acceptance.evidenceTitle')}</h3>
        <EvidenceFiles files={data.files} onOpen={setViewerFile} />
        {data.contractorChecklistDone ? <p className={styles.hint}>{t('acceptance.evidenceDone')}</p> : null}
      </div>

      {/* CTA сразу под контентом (DEV-20_2 §5): «Принять этап» + «Вернуть»
          в один ряд, каждая гаснет по своему условию; подпись — под ними. */}
      <div className={cc.actions}>
        <div className={cc.actionsRow}>
          <Button variant="primary" block disabled={!allAccepted} onClick={() => setConfirmOpen(true)} data-testid="accept-milestone">
            {t('acceptance.acceptCta')}
          </Button>
          <Button variant="outline" block disabled={!canReturn} onClick={() => void submitReturn()} data-testid="return-milestone">
            {t('acceptance.returnCtaShort')}
          </Button>
        </div>
        <span className={styles.actionsHint}>{hasRemark ? t('acceptance.returnCtaHint') : t('acceptance.acceptCtaHint')}</span>
      </div>

      <Modal
        open={confirmOpen}
        title={t('acceptance.acceptCta')}
        onClose={() => setConfirmOpen(false)}
        closeLabel={t('common.close')}
        actions={
          <>
            <Button variant="ghost" onClick={() => setConfirmOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button variant="primary" onClick={() => void confirmAccept()} data-testid="confirm-accept">
              {t('acceptance.acceptCta')}
            </Button>
          </>
        }
      >
        <p>{t('acceptance.acceptCtaHint')}</p>
      </Modal>

      <PhotoViewer
        open={!!viewerFile}
        src={viewerFile?.src}
        name={viewerFile?.name}
        onClose={() => setViewerFile(null)}
        closeLabel={t('acceptance.photoClose')}
      />

      <Ceremony
        open={ceremonyOpen}
        eyebrow={t('signing.ceremonyEyebrow')}
        title={t('acceptance.ceremonyTitle')}
        subtitle={t('acceptance.ceremonySubtitle')}
        doneLabel={t('acceptance.ceremonyDone')}
        onDone={() => {
          setCeremonyOpen(false);
          navigate(`/contracts/${id}`);
        }}
      />
    </div>
  );
}
