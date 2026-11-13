import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  ApiError,
  type ContractRole,
  type RealChecklistItem,
  type RealGateConditionState,
  type RealMilestoneGateStatus,
  type RealMilestoneStatus,
  type RealMilestoneTreeNode,
  type StageEvidenceBind,
  type StageStartConditionLink,
} from '@porukam/core';
import {
  AcceptanceChecklist,
  AcceptanceTimer,
  type BadgeTone,
  Button,
  Callout,
  ContractTimeline,
  DriveBackupPrompt,
  EmptyState,
  ErrorState,
  EvidenceList,
  EvidenceUploader,
  PartyRow,
  PhotoViewer,
  Skeleton,
  StageHeader,
  StartConditions,
  StoragePlashka,
  SubmitStageSheet,
  SuspendedBanner,
  TextArea,
  type StageChecklistItemView,
  type StageEvidenceItemView,
  type StartConditionItem,
  type StartConditionState,
} from '@porukam/ui';
import {
  useConnectStageDriveBackup,
  useStageDriveBackup,
  useStageExecution,
  useStageExecutionApi,
  useStageTimeline,
} from '../features/stageExecution/api';
import {
  useAcceptRealMilestone,
  useRealMilestone,
  useRealMilestoneAcceptance,
  useRealMilestoneEvidence,
  useRealMilestoneGate,
  useRealMilestoneTimeline,
  useRejectRealMilestone,
  useStartRealMilestone,
  useSubmitRealMilestone,
  useUploadRealEvidence,
} from '../features/stageExecution/realApi';
import {
  draftScope,
  evidenceDraftFile,
  readEvidenceDraftNote,
  writeEvidenceDraftNote,
  type StoredEvidenceDraft,
} from '../features/stageExecution/evidenceDraftStore';
import { useEvidenceDrafts } from '../features/stageExecution/useEvidenceDrafts';
import { useRealChecklistItems, useRealContractView } from '../features/contracts/realApi';
import { timelineDetailText, timelineTitleText } from '../features/contracts/timelineView';
import { isRealContractId } from '../features/contracts/realDispatch';
import { PlatformPaymentNotice } from '../features/contracts/PlatformPaymentNotice';
import { StageMaterials } from '../features/contracts/StageMaterials';
import { useRealContractPayments } from '../features/payments/realApi';
import { RealPaymentRow } from '../features/payments/RealPaymentRow';
import { useViewerStore } from '../features/contracts/viewerStore';
import { useActorStore } from '../features/actor/actorStore';
import { api } from '../shared/api';
import { useFormatters } from '../shared/formatters';
import styles from './StagePage.module.css';
import { apiErrorText } from '../shared/apiErrorText';
import { GATE_REASON_KEY, stageErrorText } from '../features/stageExecution/stageErrors';

interface PendingUpload {
  tempId: string;
  file: File;
  bind: StageEvidenceBind;
  status: 'uploading' | 'error';
  errorText?: string;
}

const STATUS_TONE: Record<string, BadgeTone> = {
  in_work: 'teal',
  suspended: 'amber',
  under_acceptance: 'amber',
  accepted: 'green',
};

let pendingSeq = 0;

/** `settings.EVIDENCE_MAX_FILE_SIZE_BYTES` (backend/config/settings/base.py) —
 * зеркалим на клиенте, чтобы не гонять заведомо большой файл на сервер и
 * получить 413 (ГВ.3 п.4). Бэкенд — источник правды, это только ранняя
 * подсказка пользователю. */
const MAX_EVIDENCE_BYTES = 25 * 1024 * 1024;

const REAL_STATUS_TONE: Record<RealMilestoneStatus, BadgeTone> = {
  pending: 'neutral',
  in_progress: 'teal',
  suspended: 'amber',
  under_acceptance: 'amber',
  accepted: 'green',
  paid: 'green',
  disputed: 'red',
};

/** `Contract.payment_method` → подпись способа расчёта (тот же словарь, что
 * в карточке договора). `payNone` — способ не выбран: у такого договора
 * счетов не бывает вовсе (гейт `payment_method_not_set`). */
const PAYMENT_METHOD_KEY: Record<string, string> = {
  cash: 'contracts.payCash',
  external: 'contracts.payExternal',
  direct_platform: 'contracts.payDirectPlatform',
  hold: 'contracts.payHold',
};

/** Три состояния условия гейта (ADR-155 §5) → состояние строки
 * `StartConditions`: «Ждём» (amber) / «Готово» (green + галочка) /
 * «Не требуется» (mute). */
const CONDITION_STATE: Record<RealGateConditionState, StartConditionState> = {
  waiting: 'waiting',
  met: 'met',
  not_required: 'na',
};

/** Якоря разделов страницы этапа — строка условия ведёт в СВОЙ раздел
 * (материалы этапа / оплаты), а не в карточку договора вообще. */
const MATERIALS_ANCHOR = 'stage-materials';
const PAYMENTS_ANCHOR = 'stage-payments';

/** Листья дерева этапов в порядке обхода — для «Этап N из M» (реальный
 * `MilestoneSerializer` этот номер не отдаёт, ADR-088: «meta — B, собрать
 * на клиенте»). */
function flattenLeaves(nodes: RealMilestoneTreeNode[]): RealMilestoneTreeNode[] {
  const out: RealMilestoneTreeNode[] = [];
  for (const n of nodes) {
    if (n.is_leaf) out.push(n);
    else out.push(...flattenLeaves(n.children));
  }
  return out;
}

interface RealPendingUpload {
  tempId: string;
  file: File;
  checklistItemId?: string;
  checklistItemLabel?: string;
  status: 'uploading' | 'error';
  errorText?: string;
}

/**
 * Реальный контур этапа (ADR-088 Фазы 5–6) — `GET /milestones/{id}` + под-
 * ресурсы (`/timeline`/`/gate`/`/acceptance`/`/evidence`), НЕ мок-агрегат
 * `StageExecutionDetail`/`MilestoneAcceptance`. Роль определяется РЕАЛЬНО
 * (по `contract.parties`), не переключателем `viewerStore` (тот — только
 * для мок-контура): сдача (`start`/`submit`/загрузка evidence) — только
 * исполнитель; приёмка (`accept`/`reject`) — ТОЛЬКО заказчик (реальный бэк
 * это проверяет сам, `403` на чужой роли — здесь просто честно не
 * показываем недоступное действие). Обе роли МОГУТ смотреть страницу —
 * действия видит только своя сторона.
 */
function RealStagePage({ contractId, milestoneId }: { contractId: string; milestoneId: string }): JSX.Element {
  const { t } = useTranslation();
  const { formatCountdown, formatDate, formatDateTime } = useFormatters();
  const navigate = useNavigate();

  const { data: view, isPending: viewPending, error: viewError, refetch: refetchView } = useRealContractView(contractId);
  const milestoneQ = useRealMilestone(milestoneId);
  const gateQ = useRealMilestoneGate(milestoneId);
  const checklistQ = useRealChecklistItems(milestoneId);
  const evidenceQ = useRealMilestoneEvidence(milestoneId);
  const timelineQ = useRealMilestoneTimeline(milestoneId);
  const milestone = milestoneQ.data;
  const acceptanceQ = useRealMilestoneAcceptance(milestoneId, milestone?.status === 'under_acceptance');
  const start = useStartRealMilestone(milestoneId);
  const submit = useSubmitRealMilestone(milestoneId);
  const upload = useUploadRealEvidence(milestoneId);
  const accept = useAcceptRealMilestone(milestoneId);
  const reject = useRejectRealMilestone(milestoneId);
  const paymentsQ = useRealContractPayments(contractId);

  const [bindValue, setBindValue] = useState('stage');
  const [pending, setPending] = useState<RealPendingUpload[]>([]);
  const [submitOpen, setSubmitOpen] = useState(false);
  const [acceptOpen, setAcceptOpen] = useState(false);
  const [rejectItemId, setRejectItemId] = useState<string | null>(null);
  const [rejectEvidenceIds, setRejectEvidenceIds] = useState<string[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [viewerFile, setViewerFile] = useState<{ src?: string; name: string; evidenceId?: string } | null>(null);
  // Ошибка последней загрузки — показывается в окне прикрепления, не только в списке.
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);
  // Прогресс выгрузки черновиков при сдаче: «Отправка 3 из 5» (ADR-160 §3).
  const [sending, setSending] = useState<{ done: number; total: number } | null>(null);
  // Хотя бы один файл не ушёл — `submit` НЕ вызываем, диалог остаётся открытым
  // с кнопкой «Повторить» (ADR-160 §3).
  const [sendFailed, setSendFailed] = useState(false);

  useEffect(
    () => () => {
      if (viewerFile?.src) URL.revokeObjectURL(viewerFile.src);
    },
    [viewerFile],
  );

  const run = (fn: () => Promise<unknown>) => {
    setErr(null);
    return fn().catch((e) => setErr(stageErrorText(e, t)));
  };

  /** Диалог сдачи/приёмки открывается и закрывается ЧИСТЫМ. Без этого жалоба
   * 05.09 читалась буквально: исполнитель получал отказ, дозагружал фото,
   * снова жал «Сдать» — и диалог показывал СТАРУЮ ошибку ещё до запроса,
   * а сдача при этом проходила. Закрытие чистит по той же причине: `err`
   * рисуется и в теле страницы, где он уже ни к чему не относится. */
  const toggleSheet = (set: (open: boolean) => void) => (open: boolean) => {
    setErr(null);
    set(open);
  };
  const setSubmitSheet = toggleSheet(setSubmitOpen);
  const setAcceptSheet = toggleSheet(setAcceptOpen);

  const myProfileId = useActorStore((s) => s.activeProfileId);
  const myParty = view?.contract.parties.find((p) => p.profile_id === myProfileId);
  const myRole = myParty?.role;
  const counterpartyRole: ContractRole | undefined = myRole === 'customer' ? 'contractor' : myRole === 'contractor' ? 'customer' : undefined;
  const isContractor = myRole === 'contractor';
  const isCustomer = myRole === 'customer';

  /**
   * Режим черновика (ADR-160, решение владельца 05.09): приложенные файлы
   * живут ТОЛЬКО на устройстве (IndexedDB) и удаляются одним касанием; на
   * сервер уходят все разом, одной кнопкой. Сервер не меняется — `POST
   * /milestones/{id}/evidence` по-прежнему хеширует и уведомляет сразу,
   * поэтому единственное место, где удаление возможно, — до отправки.
   *
   * ОБЕ стороны (расширение 05.09: «дать заказчику такой же черновик и кнопку
   * "Отправить приложенное". вдруг он случайно личное фото приложит»):
   *  - исполнитель, `in_progress` — черновик уходит по «Сдать этап» (`submit`
   *    в MILESTONE_FSM есть ровно из `in_progress`);
   *  - заказчик, `in_progress` и `under_acceptance` — черновик уходит по
   *    «Отправить приложенное»: кнопки сдачи у него нет и не будет, но
   *    прикладывает он именно в эти два статуса (в `under_acceptance` — глядя
   *    на сданную работу, ради отклонения по пункту).
   *
   * Черновики сторон не пересекаются: scope = `<ownerId>::<milestoneId>`,
   * ownerId — активный профиль, поэтому заказчик не видит черновик исполнителя
   * даже на общем устройстве.
   */
  const contractorDraftMode = isContractor && milestone?.status === 'in_progress';
  const customerDraftMode =
    isCustomer && (milestone?.status === 'in_progress' || milestone?.status === 'under_acceptance');
  const draftMode = contractorDraftMode || customerDraftMode;
  const drafts = useEvidenceDrafts(milestoneId, myProfileId, draftMode);
  const draftList = drafts.drafts;

  /**
   * Описание партии («он даст описание и потом одним рейсом все отправит»).
   * Живёт рядом с черновиком и переживает перезагрузку вкладки по той же
   * причине, что и фотографии: на Android вкладка после камеры
   * перезагружается, и набранный до съёмки текст иначе пропадал бы молча.
   * Ключ — тот же scope, поэтому описание заказчика не подмешается в отправку
   * исполнителя.
   */
  const noteScope = draftScope(myProfileId, milestoneId);
  const [description, setDescription] = useState(() => readEvidenceDraftNote(noteScope));
  useEffect(() => {
    setDescription(readEvidenceDraftNote(noteScope));
  }, [noteScope]);
  function onDescriptionChange(text: string): void {
    setDescription(text);
    writeEvidenceDraftNote(noteScope, text);
  }

  // Миниатюры черновиков — из самих Blob'ов. Один URL на запись, живёт ровно
  // столько, сколько запись в списке (просмотрщик получает СВОЙ URL, иначе его
  // revoke убил бы миниатюру).
  const [draftUrls, setDraftUrls] = useState<Record<string, string>>({});
  useEffect(() => {
    if (typeof URL.createObjectURL !== 'function') return;
    const urls: Record<string, string> = {};
    for (const d of draftList) if (d.fileType.startsWith('image/')) urls[d.id] = URL.createObjectURL(d.blob);
    setDraftUrls(urls);
    return () => {
      for (const url of Object.values(urls)) URL.revokeObjectURL(url);
    };
  }, [draftList]);

  if (viewPending || milestoneQ.isPending) {
    return (
      <div className={styles.wrap}>
        <Skeleton width="60%" height={30} />
        <Skeleton width="100%" height={80} radius="var(--pr-r-lg)" />
        <Skeleton width="100%" height={200} radius="var(--pr-r-lg)" />
      </div>
    );
  }

  if (viewError || !view) {
    return (
      <div className={styles.wrap}>
        <ErrorState title={t('stage.errorText')} retryLabel={t('common.retry')} onRetry={() => void refetchView()} />
      </div>
    );
  }

  if (milestoneQ.error || !milestone) {
    return (
      <div className={styles.wrap}>
        <ErrorState title={t('stage.errorText')} retryLabel={t('common.retry')} onRetry={() => void milestoneQ.refetch()} />
      </div>
    );
  }

  if (!myRole) {
    return (
      <div className={styles.wrap}>
        <Callout tone="warn" title={t('stage.realNotPartyTitle')}>
          <Button variant="ghost" onClick={() => navigate(`/contracts/${contractId}`)}>
            {t('signing.backToContract')}
          </Button>
        </Callout>
      </div>
    );
  }

  /** Причина неудачи загрузки одним словарём на прямую загрузку и на выгрузку
   * черновиков: 413 может прийти и от nginx (HTML, без problem+json) — текст
   * про размер берём свой, не «Request Entity Too Large» (отсмотр 2026-08-25);
   * 429 несёт человеческий `detail` от бэка (`rate_limited`). */
  function uploadErrorReason(e: unknown): string {
    // 413 может прийти и от nginx (HTML, без problem+json), остальное —
    // по коду ошибки (ADR-164: служебный `detail` бэка человеку не показываем).
    if (e instanceof ApiError && e.status === 413) return t('stage.realUploadTooLarge');
    return stageErrorText(e, t);
  }

  function uploadErrorText(e: unknown, name: string): string {
    return t('stage.uploadFailedInline', { name, reason: uploadErrorReason(e) });
  }

  async function runUpload(tempId: string, file: File, checklistItemId: string | undefined, checklistItemLabel: string | undefined): Promise<void> {
    setUploadError(null);
    setPending((p) => (p.some((x) => x.tempId === tempId) ? p.map((x) => (x.tempId === tempId ? { ...x, status: 'uploading', errorText: undefined } : x)) : [...p, { tempId, file, checklistItemId, checklistItemLabel, status: 'uploading' }]));
    try {
      await upload.mutateAsync({ file, checklistItemId });
      setPending((p) => p.filter((x) => x.tempId !== tempId));
    } catch (e) {
      const message = uploadErrorReason(e);
      setPending((p) => p.map((x) => (x.tempId === tempId ? { ...x, status: 'error', errorText: message } : x)));
      setUploadError(t('stage.uploadFailedInline', { name: file.name, reason: message }));
    }
  }

  function resolveChecklistItemId(value: string): { id?: string; label?: string } {
    if (value === 'stage') return {};
    const item = checklistQ.data?.find((c) => c.id === value);
    return { id: value, label: item?.description };
  }

  /** Слишком большой файл не имеет смысла ни отправлять, ни класть в черновик:
   * бэк ответит 413 (`EVIDENCE_MAX_FILE_SIZE_BYTES`) — говорим это сразу. */
  function tooLarge(file: File, checklistItemId: string | undefined, label: string | undefined): boolean {
    if (file.size <= MAX_EVIDENCE_BYTES) return false;
    setUploadError(t('stage.uploadFailedInline', { name: file.name, reason: t('stage.realUploadTooLarge') }));
    if (!draftMode) {
      pendingSeq += 1;
      const tempId = `pending-${pendingSeq}`;
      setPending((p) => [...p, { tempId, file, checklistItemId, checklistItemLabel: label, status: 'error', errorText: t('stage.realUploadTooLarge') }]);
    }
    return true;
  }

  function addFile(file: File, checklistItemId: string | undefined, label: string | undefined): void {
    if (draftMode) {
      setUploadError(null);
      void drafts.add(file, checklistItemId, label);
      return;
    }
    pendingSeq += 1;
    void runUpload(`pending-${pendingSeq}`, file, checklistItemId, label);
  }

  function onSelectFiles(files: File[]): void {
    const { id: checklistItemId, label } = resolveChecklistItemId(bindValue);
    for (const file of files) {
      if (tooLarge(file, checklistItemId, label)) continue;
      addFile(file, checklistItemId, label);
    }
  }

  function onAttachToItem(itemId: string, file: File): void {
    const item = checklistQ.data?.find((c) => c.id === itemId);
    if (tooLarge(file, itemId, item?.description)) return;
    addFile(file, itemId, item?.description);
  }

  /** Просмотр черновика — свой object URL: общий эффект чистки `viewerFile.src`
   * иначе отозвал бы URL миниатюры в списке. */
  function onViewDraft(draft: StoredEvidenceDraft): void {
    const src = typeof URL.createObjectURL === 'function' ? URL.createObjectURL(draft.blob) : undefined;
    setViewerFile({ name: draft.fileName, ...(src ? { src } : {}) });
  }

  /** Одна точка входа для строки списка: черновик показываем из локального
   * Blob'а, серверное доказательство — через `GET /evidence/{id}/thumbnail`. */
  function onViewItem(item: StageEvidenceItemView): void {
    const draft = draftList.find((d) => d.id === item.id);
    if (draft) {
      onViewDraft(draft);
      return;
    }
    void onViewEvidence(item.id, item.filename);
  }

  async function onViewEvidence(evidenceId: string, filename: string): Promise<void> {
    setViewerFile({ name: filename, evidenceId });
    try {
      const blob = await api.request<Blob>(`/evidence/${evidenceId}/thumbnail`, { actor: true, responseType: 'blob' });
      setViewerFile({ src: URL.createObjectURL(blob), name: filename, evidenceId });
    } catch {
      // 404 — миниатюры нет (EvidenceThumbnailView докстринг, «не подделывается»)
      // — просмотрщик говорит это словами и предлагает скачать оригинал.
    }
  }

  async function onDownloadEvidence(): Promise<void> {
    if (!viewerFile?.evidenceId) return;
    setDownloading(true);
    try {
      const blob = await api.request<Blob>(`/evidence/${viewerFile.evidenceId}/download`, { actor: true, responseType: 'blob' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = viewerFile.name;
      a.rel = 'noopener';
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (e) {
      setErr(stageErrorText(e, t));
    } finally {
      setDownloading(false);
    }
  }

  async function onStart(): Promise<void> {
    // 409 гейта — не «ошибка сервера», а причина, по которой этап пока не
    // стартует; её, как и все остальные коды, разбирает `stageErrorText`
    // (ADR-164: служебный `detail` бэка человеку не показываем).
    await run(() => start.mutateAsync());
  }

  /**
   * Сдача этапа (ADR-160 §3): СНАЧАЛА последовательно уходят все черновики,
   * ПОТОМ `submit`. Порядок обязателен — после `submit` этап уже
   * `under_acceptance`, и второй стороне пришлось бы смотреть приёмку без
   * половины доказательств.
   *
   * Упавший файл остаётся в черновике с текстом ошибки, остальные — отправлены
   * (повторная отправка уже ушедших не нужна: их в черновике больше нет).
   * `submit` при этом НЕ вызывается, диалог остаётся открытым с «Повторить».
   */
  async function onConfirmSubmit(): Promise<void> {
    setErr(null);
    setSendFailed(false);
    if (draftMode && draftList.length > 0 && !(await sendDraftQueue())) {
      setSendFailed(true);
      setErr(t('stage.draftSendFailed'));
      return;
    }
    await run(async () => {
      await submit.mutateAsync({});
      // Сдача прошла — черновику больше незачем жить на устройстве.
      if (draftMode) {
        await drafts.clear();
        onDescriptionChange('');
      }
      setSubmitSheet(false);
    });
  }

  /**
   * Очередь выгрузки черновика — общая для «Сдать этап» (исполнитель) и
   * «Отправить приложенное» (заказчик): ПОСЛЕДОВАТЕЛЬНО, не параллельно, с
   * прогрессом «Отправка 3 из 5». Возвращает `true`, если ушли ВСЕ файлы.
   *
   * Упавший файл остаётся в черновике с текстом ошибки, ушедшие — уже нет
   * (повторно они не уйдут). На 429 очередь останавливается сразу: следующий
   * файл упёрся бы в тот же лимит частоты, и мы бы разметили ошибками файлы,
   * которые даже не пробовали отправить.
   *
   * Описание уходит с КАЖДЫМ файлом партии: «партии» на бэке нет, строка
   * Evidence дальше живёт сама по себе — в ленте спора, в архивной выгрузке —
   * и подпись «что тут снято» обязана ехать вместе с ней.
   */
  async function sendDraftQueue(): Promise<boolean> {
    const queue = [...draftList];
    if (queue.length === 0) return true;
    const note = description.trim();
    let done = 0;
    let failed = false;
    setSending({ done, total: queue.length });
    for (const draft of queue) {
      try {
        await upload.mutateAsync({
          file: evidenceDraftFile(draft),
          ...(draft.checklistItemId ? { checklistItemId: draft.checklistItemId } : {}),
          ...(note ? { description: note } : {}),
        });
        await drafts.remove(draft.id);
        done += 1;
        setSending({ done, total: queue.length });
      } catch (e) {
        failed = true;
        await drafts.markError(draft.id, uploadErrorText(e, draft.fileName));
        if (e instanceof ApiError && e.is('rate_limited')) break;
      }
    }
    setSending(null);
    return !failed;
  }

  /**
   * «Отправить приложенное» — отправка партии заказчиком (расширение ADR-160
   * от 05.09). Ровно то, чего просил владелец: файлы копятся на устройстве,
   * человек пишет одно описание и «одним рейсом всё отправляет».
   *
   * Сдачи этапа за этим не следует: у заказчика её нет и не будет — отправка
   * материалов самостоятельное действие, а не половина чужого.
   */
  async function onSendAttached(): Promise<void> {
    setErr(null);
    setUploadError(null);
    setSendFailed(false);
    if (!(await sendDraftQueue())) {
      setSendFailed(true);
      setErr(t('stage.draftSendFailedAttach'));
      return;
    }
    // Описание уехало вместе с файлами — в поле его оставлять нельзя: следующая
    // партия молча подписалась бы текстом от предыдущей.
    onDescriptionChange('');
  }

  /** Повтор строки списка: у заказчика черновик перезапускает ВСЮ очередь (в
   *  ней остались только упавшие), у прямой загрузки — свой файл. */
  function onRetryItem(id: string): void {
    if (customerDraftMode && draftList.some((d) => d.id === id)) {
      void onSendAttached();
      return;
    }
    const p = pending.find((x) => x.tempId === id);
    if (p) void runUpload(id, p.file, p.checklistItemId, p.checklistItemLabel);
  }

  async function onConfirmAccept(): Promise<void> {
    await run(async () => {
      await accept.mutateAsync();
      setAcceptSheet(false);
    });
  }

  function onSelectRejectItem(itemId: string): void {
    setRejectItemId(itemId);
    setRejectEvidenceIds([]);
  }

  function onToggleRejectEvidence(evidenceId: string, checked: boolean): void {
    setRejectEvidenceIds((ids) => (checked ? [...ids, evidenceId] : ids.filter((id) => id !== evidenceId)));
  }

  async function onConfirmReject(): Promise<void> {
    if (!rejectItemId || rejectEvidenceIds.length === 0) return;
    await run(async () => {
      await reject.mutateAsync({ checklist_item_id: rejectItemId, evidence: rejectEvidenceIds });
      setRejectItemId(null);
      setRejectEvidenceIds([]);
    });
  }

  function onOpenCondition(linkRef: string): void {
    // Материалы и оплаты этого этапа живут НА ЭТОЙ ЖЕ странице (ADR-155) —
    // строка условия ведёт в свой раздел, а не в карточку договора вообще.
    // Раздела может не быть (материалов нет, счёт ещё не выставлен) — тогда
    // остаётся прежний переход в карточку.
    const anchor = linkRef === 'materials' ? MATERIALS_ANCHOR : linkRef === 'payment' ? PAYMENTS_ANCHOR : null;
    const el = anchor ? document.getElementById(anchor) : null;
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }
    navigate(`/contracts/${contractId}`);
  }

  const leaves = flattenLeaves(view.milestones);
  const leafIndex = leaves.findIndex((l) => l.id === milestoneId);
  const indexLabel = t('stage.stageOf', { index: leafIndex >= 0 ? leafIndex + 1 : 1, total: Math.max(leaves.length, 1) });
  const counterparty = counterpartyRole ? t(counterpartyRole === 'customer' ? 'contract.roleCustomer' : 'contract.roleContractor') : '';
  const shifted = (milestone.frozen_days ?? 0) > 0;
  const statusLabel =
    milestone.status === 'pending'
      ? t('stage.realStatusPending')
      : milestone.status === 'in_progress'
        ? t('stage.statusInWork')
        : milestone.status === 'suspended'
          ? t('stage.statusSuspended')
          : milestone.status === 'under_acceptance'
            ? t('stage.statusUnderAcceptance')
            : milestone.status === 'disputed'
              ? t('stage.realStatusDisputed')
              : milestone.status === 'paid'
                ? t('stage.realStatusPaid')
                : t('stage.statusAccepted');

  const gate: RealMilestoneGateStatus | undefined = gateQ.data;
  // ADR-155 §5: состояние КАЖДОГО условия приезжает строкой. До подписания
  // бэк отдаёт все три `waiting` (решение владельца 03.09) — «Готово» там,
  // где договора ещё нет, вводило бы в заблуждение; фронт это не
  // пересчитывает, а показывает.
  //
  // При предоплате финансовое условие называется своим именем — «Оплата
  // этапа заказчиком»: «финансовое условие» ничего не говорит человеку о
  // том, чего именно ждут.
  const prepaid = view.contract.payment_order === 'before_start';
  const startConditionItems: StartConditionItem[] = gate
    ? [
        { key: 'contract_signed', label: t('stage.realConditionSigned'), state: CONDITION_STATE[gate.conditions.signed], linkRef: 'contract' },
        { key: 'materials', label: t('stage.realConditionMaterials'), state: CONDITION_STATE[gate.conditions.materials], linkRef: 'materials' },
        {
          key: 'financial',
          label: prepaid ? t('stage.realConditionPrepayment') : t('stage.realConditionFinancial'),
          state: CONDITION_STATE[gate.conditions.financial],
          sub: gate.financial_condition_reason ? t(GATE_REASON_KEY[gate.financial_condition_reason] ?? gate.financial_condition_reason) : undefined,
          linkRef: 'payment',
        },
      ]
    : [];
  const startConditionLabels: Record<StartConditionState, string> = {
    met: t('stage.startConditionMet'),
    waiting: t('stage.startConditionWaiting'),
    na: t('stage.startConditionNa'),
  };

  const checklist = checklistQ.data ?? [];
  const evidence = evidenceQ.data ?? [];

  /** ADR-164: пункты, которые просят фото и его не получили. Источник —
   * СЕРВЕР (`milestone.uncovered_required_evidence`), а не пересчёт по
   * загруженным файлам: та же истина, что увидит вторая сторона. Пока
   * карточка этапа не пришла — список пуст (предупреждать не о чем).
   *
   * Исключение — ЧЕРНОВИКИ (ADR-160): файл уже приложен, но лежит на
   * устройстве и уйдёт на сервер только при сдаче, поэтому сервер о нём знать
   * не может. Без этой поправки один и тот же пункт был бы одновременно
   * «приложено · 1» и «фото нет». */
  const draftCoveredIds = new Set(draftList.map((d) => d.checklistItemId).filter((id): id is string => !!id));
  const uncoveredIds = new Set((milestone.uncovered_required_evidence ?? []).filter((id) => !draftCoveredIds.has(id)));
  const uncoveredLabels = checklist.filter((c) => uncoveredIds.has(c.id)).map((c) => c.description);

  const checklistItems: StageChecklistItemView[] = checklist.map((c: RealChecklistItem) => {
    // Два РАЗНЫХ счётчика, а не один общий (правка 05.09).
    //
    // «приложено · N» — только то, что реально ушло на сервер. Раньше сюда
    // приплюсовывались и черновики, и получалась ложь для обеих сторон: своё
    // «приложено» человек читает как «дело сделано», а на приёмке тот же
    // счётчик у заказчика значит «файл у меня есть» — хотя черновик СВОЙ и
    // второй стороне не виден вовсе.
    //
    // «черновик · N» — свои файлы на устройстве. Отдельная пометка честнее
    // общей суммы: она говорит и что фото уже выбрано (второе прикладывать не
    // надо), и что оно ещё никуда не ушло.
    const attached = evidence.filter((e) => e.checklist_item_id === c.id).length;
    const drafted = draftList.filter((d) => d.checklistItemId === c.id).length;
    return {
      id: c.id,
      label: c.description,
      optional: c.required_evidence.length === 0,
      optionalLabel: c.required_evidence.length === 0 ? t('stage.checklistOptional') : undefined,
      attachedLabel: attached > 0 ? t('stage.attachedCount', { count: attached }) : undefined,
      draftCountLabel: drafted > 0 ? t('stage.draftCount', { count: drafted }) : undefined,
      // Пометка «фото не приложено» — обеим сторонам: исполнителю как
      // напоминание, заказчику на приёмке как повод отклонить по пункту.
      // Черновик её снимает намеренно (см. `uncoveredIds` выше): к моменту
      // сдачи файл уже уйдёт, и предупреждать в диалоге не о чем.
      warningLabel: uncoveredIds.has(c.id) ? t('stage.checklistNoEvidence') : undefined,
    };
  });

  const evidenceItems: StageEvidenceItemView[] = [
    ...evidence.map(
      (e): StageEvidenceItemView => ({
        id: e.id,
        filename: e.file_name,
        kind: e.mime_type.startsWith('image/') ? 'image' : 'doc',
        status: 'stored',
        uploadedLabel: t('stage.evidenceUploadedAt', { time: formatDateTime(e.trusted_timestamp_at) }),
        hashedLabel: t('stage.evidenceHashed'),
        // Пояснение автора, данное при загрузке (решение владельца 05.09):
        // без него список — это столбик имён файлов с телефона.
        description: e.description,
        bindLabel: e.checklist_item_id
          ? t('stage.evidenceBindItem', { label: checklist.find((c) => c.id === e.checklist_item_id)?.description ?? '' })
          : t('stage.evidenceBindStage'),
        // Уже на сервере — хеш зафиксирован, удаления нет (инвариант CLAUDE.md).
        deletable: false,
      }),
    ),
    // Черновики (ADR-160): ещё на устройстве, удаляются одним касанием.
    ...draftList.map(
      (d): StageEvidenceItemView => ({
        id: d.id,
        filename: d.fileName,
        kind: d.fileType.startsWith('image/') ? 'image' : 'doc',
        thumbUrl: draftUrls[d.id],
        status: 'draft',
        draftLabel: t('stage.draftBadge'),
        // То, что уедет вместе с файлом, — показываем ДО отправки: описание
        // изменить потом нечем (PATCH на доказательство нет).
        description: description.trim(),
        bindLabel: d.checklistItemId ? t('stage.evidenceBindItem', { label: d.checklistItemLabel ?? '' }) : t('stage.evidenceBindStage'),
        errorLabel: d.errorText,
      }),
    ),
    ...pending.map(
      (p): StageEvidenceItemView => ({
        id: p.tempId,
        filename: p.file.name,
        kind: p.file.type.startsWith('image/') ? 'image' : 'doc',
        status: p.status === 'uploading' ? 'uploading' : 'stored',
        bindLabel: p.checklistItemId ? t('stage.evidenceBindItem', { label: p.checklistItemLabel ?? '' }) : t('stage.evidenceBindStage'),
        errorLabel: p.errorText,
      }),
    ),
  ];

  const bindOptions = [
    { id: 'stage', label: t('stage.uploaderBindStageOption') },
    ...checklist.map((c) => ({ id: c.id, label: c.description })),
  ];

  const inProgress = milestone.status === 'in_progress';

  /**
   * Карточка доказательств этапа. Для ЗАКАЗЧИКА в ней живёт черновик
   * (расширение ADR-160 от 05.09):
   * приложить → описать → пересмотреть → «Отправить приложенное». Порядок
   * блоков и есть смысл решения владельца: до последней кнопки на сервер не
   * уходит НИЧЕГО, и «случайно приложенное личное фото» убирается корзиной.
   *
   * Та же карточка обслуживает `in_progress` и `under_acceptance` — прикладывает
   * заказчик и там, и там, а список доказательств у него один.
   */
  const evidenceCard = (
    <div className={styles.card}>
      <h3 className={styles.sectionTitle}>{t('stage.evidenceTitle')}</h3>
      {customerDraftMode ? (
        <>
          {/* Подсказка говорит правду про устройство, а не про неизменность:
              «неизменны» файлы становятся только после отправки. */}
          <Callout tone="neutral">{t('stage.draftCustomerHint')}</Callout>
          <EvidenceUploader
            dropLabel={t('stage.uploaderDropLabel')}
            browseLabel={t('stage.uploaderBrowseLabel')}
            bindLabel={t('stage.uploaderBindLabel')}
            bindHint={t('stage.uploaderBindHint')}
            bindOptions={bindOptions}
            bindValue={bindValue}
            onBindChange={setBindValue}
            onSelectFiles={onSelectFiles}
            cameraStubText={t('stage.cameraStubText')}
            errorText={uploadError ?? undefined}
            dismissErrorLabel={t('common.close')}
            onDismissError={() => setUploadError(null)}
          />
          <TextArea
            label={t('stage.draftDescriptionLabel')}
            hint={t('stage.draftDescriptionHint')}
            rows={3}
            maxLength={2000}
            value={description}
            onChange={(e) => onDescriptionChange(e.target.value)}
            data-testid="draft-description"
          />
        </>
      ) : null}
      <EvidenceList
        items={evidenceItems}
        emptyText={t('stage.evidenceEmpty')}
        onView={onViewItem}
        deleteLabel={t('stage.evidenceDelete')}
        onDelete={draftMode ? (id) => void drafts.remove(id) : undefined}
        retryLabel={t('stage.evidenceRetry')}
        onRetry={onRetryItem}
      />
      {customerDraftMode ? (
        <div className={styles.actionsBar}>
          {/* Пока черновик не прочитан из хранилища, отправлять нечего:
              иначе кнопка была бы активна с пустым списком после перезагрузки. */}
          <Button
            variant="primary"
            block
            disabled={draftList.length === 0 || !drafts.ready}
            loading={sending !== null}
            onClick={() => void onSendAttached()}
            data-testid="send-attached-cta"
          >
            {sendFailed ? t('stage.draftRetry') : t('stage.draftSendCta')}
          </Button>
          <span className={styles.actionsHint}>
            {sending ? t('stage.draftSending', { done: sending.done, total: sending.total }) : t('stage.draftSendHint')}
          </span>
        </div>
      ) : null}
    </div>
  );

  const header = (
    <StageHeader
      title={milestone.title}
      indexLabel={indexLabel}
      counterparty={counterparty}
      statusLabel={statusLabel}
      statusTone={REAL_STATUS_TONE[milestone.status]}
      deadlineLabel={milestone.deadline ? `${t('stage.deadlineLabel')}: ${formatDate(milestone.deadline, { legal: true })}` : undefined}
      shifted={shifted}
      shiftedLabel={shifted ? t('stage.suspendedShifted') : undefined}
    />
  );

  // Э5/ADR-130: блок оплаты этапа читает ТОТ ЖЕ ресурс, что вкладка «Оплаты»
  // карточки договора (`GET /contracts/{id}/payments`), только отфильтрованный
  // по этому листу. Источник правды о деньгах — `Payment`, а не отметки
  // `paid_confirmed_*_at` на самом этапе: они остались денормализованным
  // зеркалом, которое пишет только `apps.payments.services` (ADR-130 §1).
  //
  // Счёт по листу ОДИН (ADR-155 §2) — меняется только момент выставления:
  // при `payment_order=before_start` он есть с подписания (оплата — условие
  // старта, §6.3), при постоплате появляется после приёмки. Подтверждается
  // одним `POST /payments/{id}/confirm` обеими сторонами.
  //
  // Пусто — либо счетов ещё не выставляли, либо способ расчёта требует
  // платёжного партнёра (`direct_platform`/`hold`): бэк по таким договорам
  // счетов не создаёт вовсе, и вместо строк остаётся `PlatformPaymentNotice`.
  const milestonePayments = (paymentsQ.data ?? []).filter((p) => p.milestone_id === milestoneId);
  const paymentMethodKey = PAYMENT_METHOD_KEY[view.contract.payment_method ?? ''] ?? 'contracts.payNone';
  const paymentsCard =
    milestonePayments.length > 0 ? (
      <div className={styles.card} id={PAYMENTS_ANCHOR} data-testid="stage-payment-confirm">
        <h3 className={styles.sectionTitle}>{t('stage.realPayTitle')}</h3>
        <p className={styles.actionsHint}>
          {t(paymentMethodKey)}
          {prepaid ? ` · ${t('stage.realPayBeforeStartHint')}` : ''}
        </p>
        <ul className={styles.paymentList}>
          {milestonePayments.map((payment) => (
            <RealPaymentRow key={payment.id} payment={payment} paymentOrder={view.contract.payment_order} titleMode="kind" variant="plain" onError={setErr}>
              <PartyRow
                name={t('contract.roleCustomer')}
                role={isCustomer ? t('stage.realPayYou') : t('stage.realPayCounterparty')}
                signState={payment.payer_confirmed_at ? 'signed' : 'pending'}
                signedAt={payment.payer_confirmed_at ?? undefined}
                signedLabel={t('payment.confirmedLabel')}
                pendingLabel={t('payment.waitingLabel')}
              />
              <PartyRow
                name={t('contract.roleContractor')}
                role={isContractor ? t('stage.realPayYou') : t('stage.realPayCounterparty')}
                signState={payment.payee_confirmed_at ? 'signed' : 'pending'}
                signedAt={payment.payee_confirmed_at ?? undefined}
                signedLabel={t('payment.confirmedLabel')}
                pendingLabel={t('payment.waitingLabel')}
              />
            </RealPaymentRow>
          ))}
        </ul>
      </div>
    ) : null;

  let body: JSX.Element;

  if (milestone.status === 'pending') {
    body = (
      <>
        {err ? <Callout tone="warn">{err}</Callout> : null}
        <StartConditions
          title={t('stage.startConditionsTitle')}
          items={startConditionItems}
          stateLabels={startConditionLabels}
          openLabel={t('stage.openLabel')}
          onOpen={onOpenCondition}
        />
        <StageMaterials contractId={contractId} milestoneId={milestoneId} myRole={myRole} anchorId={MATERIALS_ANCHOR} />
        {/* Предоплатный счёт ДЕРЖИТ гейт §6.3 (ADR-155 §1): без обоих
            подтверждений этап не стартует. Поэтому строка нужна здесь, до
            старта, а не только на принятом этапе. */}
        {paymentsCard}
        {/* ADR-162: «Начать этап» больше не действие — лист стартует сам,
            как только закрыто последнее условие выше (замечание владельца
            05.09: «сейчас ждёт ручного подтверждения. лишняя активность»).
            Обеим сторонам показываем ОДНУ подпись вместо кнопки исполнителю
            и «ждём исполнителя» заказчику: ждут теперь не человека, а
            условия. Кнопка остаётся запасным выходом из рассинхрона — все
            условия выполнены (`can_start`), а статус ещё `pending`. */}
        <div className={styles.actionsBar}>
          <span className={styles.actionsHint} data-testid="auto-start-note">{t('stage.realAutoStartNote')}</span>
          {gate?.can_start ? (
            <Button variant="ghost" size="sm" loading={start.isPending} onClick={() => void onStart()} data-testid="start-stage-cta">
              {t('stage.realStartCta')}
            </Button>
          ) : null}
        </div>
      </>
    );
  } else if (milestone.status === 'suspended') {
    body = (
      <>
        <SuspendedBanner title={t('stage.suspendedTitle')} text={t('stage.suspendedText')} shiftedLabel={shifted ? t('stage.suspendedShifted') : undefined} />
        <StartConditions
          title={t('stage.startConditionsTitle')}
          items={startConditionItems}
          stateLabels={startConditionLabels}
          openLabel={t('stage.openLabel')}
          onOpen={onOpenCondition}
        />
        {/* Приостановка снимается именно отметкой «получено» (ADR-019/155) —
            список материалов обязан быть здесь, а не только на карточке. */}
        <StageMaterials contractId={contractId} milestoneId={milestoneId} myRole={myRole} anchorId={MATERIALS_ANCHOR} />
        {paymentsCard}
        {isContractor ? (
          <div className={styles.actionsBar}>
            <Button variant="primary" block disabled data-testid="submit-stage-cta">
              {t('stage.submitCta')}
            </Button>
            <span className={styles.actionsHint}>{t('stage.submitSuspendedHint')}</span>
          </div>
        ) : null}
      </>
    );
  } else if (milestone.status === 'accepted' || milestone.status === 'paid') {
    body = (
      <>
        {err ? <Callout tone="warn">{err}</Callout> : null}
        <div className={styles.centeredState}>
          <Callout tone="neutral" title={milestone.status === 'paid' ? t('stage.realStatusPaid') : t('stage.acceptedTitle')}>
            {milestone.status === 'paid' ? t('stage.realPaidText') : t('stage.acceptedText')}
          </Callout>
        </div>
        {paymentsCard ?? <PlatformPaymentNotice paymentMethod={view.contract.payment_method} />}
        <div className={styles.card}>
          <h3 className={styles.sectionTitle}>{t('stage.evidenceTitle')}</h3>
          <EvidenceList items={evidenceItems} emptyText={t('stage.evidenceEmpty')} onView={onViewItem} deleteLabel={t('stage.evidenceDelete')} />
        </div>
      </>
    );
  } else if (milestone.status === 'disputed') {
    body = (
      <>
        <div className={styles.centeredState}>
          <Callout tone="warn" title={t('stage.realStatusDisputed')}>
            {t('stage.realDisputedText')}
          </Callout>
        </div>
        <div className={styles.card}>
          <h3 className={styles.sectionTitle}>{t('stage.evidenceTitle')}</h3>
          <EvidenceList items={evidenceItems} emptyText={t('stage.evidenceEmpty')} onView={onViewItem} deleteLabel={t('stage.evidenceDelete')} />
        </div>
        {isCustomer ? (
          <>
            {err ? <Callout tone="warn">{err}</Callout> : null}
            <div className={styles.actionsBar}>
              <Button variant="primary" block loading={accept.isPending} onClick={() => setAcceptSheet(true)} data-testid="accept-milestone-cta">
                {t('stage.realAcceptAnywayCta')}
              </Button>
              <span className={styles.actionsHint}>{t('stage.realAcceptAnywayHint')}</span>
            </div>
          </>
        ) : null}
      </>
    );
  } else if (milestone.status === 'under_acceptance') {
    const acceptance = acceptanceQ.data;
    body = (
      <>
        {err ? <Callout tone="warn">{err}</Callout> : null}
        {acceptance?.deadline_at ? (
          <AcceptanceTimer
            valueLabel={t('stage.timerValue', { time: formatCountdown(acceptance.deadline_at, Date.now()) })}
            hint={t('stage.timerHint', { date: formatDate(acceptance.deadline_at, { legal: true }) })}
          />
        ) : (
          <Callout tone="neutral">{t('stage.realAcceptanceNotPlacedYet')}</Callout>
        )}
        {evidenceCard}
        {isCustomer ? (
          <div className={styles.card}>
            <h3 className={styles.sectionTitle}>{t('stage.realAcceptanceReviewTitle')}</h3>
            {checklist.length === 0 ? (
              <Callout tone="neutral">{t('stage.realNoChecklistHint')}</Callout>
            ) : (
              <ul className={styles.reviewList} data-testid="acceptance-review-list">
                {checklist.map((c) => {
                  const itemEvidence = evidence.filter((e) => e.checklist_item_id === c.id);
                  const selected = rejectItemId === c.id;
                  return (
                    <li key={c.id} className={styles.reviewItem} data-testid="acceptance-review-item">
                      <label className={styles.reviewChoice}>
                        <input type="radio" name="reject-checklist-item" checked={selected} onChange={() => onSelectRejectItem(c.id)} />
                        {c.description}
                      </label>
                      {selected ? (
                        <div className={styles.reviewEvidence}>
                          {itemEvidence.length === 0 ? (
                            // Раньше это был тупик: исполнитель мог сдать этап без
                            // единого файла (ADR-164 — фото совет, а не запрет), и
                            // отклонить по пункту становилось нечем. Теперь у
                            // заказчика есть свой черновик — говорим, куда идти.
                            <Callout tone="warn">
                              {t('stage.realRejectNoEvidence')} {t('stage.realRejectAttachHint')}
                            </Callout>
                          ) : (
                            itemEvidence.map((e) => (
                              <label key={e.id} className={styles.evidenceOption}>
                                <input type="checkbox" checked={rejectEvidenceIds.includes(e.id)} onChange={(ev) => onToggleRejectEvidence(e.id, ev.target.checked)} />
                                {e.file_name}
                              </label>
                            ))
                          )}
                        </div>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            )}
            <div className={styles.actionsBar}>
              <Button variant="primary" block loading={accept.isPending} onClick={() => setAcceptSheet(true)} data-testid="accept-milestone-cta">
                {t('stage.realAcceptCta')}
              </Button>
              <Button variant="destructive" block loading={reject.isPending} disabled={!rejectItemId || rejectEvidenceIds.length === 0} onClick={() => void onConfirmReject()} data-testid="reject-milestone-cta">
                {t('stage.realRejectCta')}
              </Button>
              <span className={styles.actionsHint}>{t('stage.realRejectHint')}</span>
            </div>
          </div>
        ) : null}
        {timelineQ.data && timelineQ.data.length > 0 ? (
          <div className={styles.card}>
            {/* Подпись события — та же, что в хронике договора (ADR-134):
              * локализованный `title` с бэка, а не код `milestone.submitted`
              * (находка 07.09). Общий помощник — `timelineView`, чтобы обе
              * хроники не разъезжались. */}
            <ContractTimeline
              events={timelineQ.data.map((e) => ({
                id: e.event_id,
                title: timelineTitleText(e, t),
                detail: timelineDetailText(e),
                at: formatDateTime(e.occurred_at),
                done: true,
              }))}
            />
          </div>
        ) : null}
      </>
    );
  } else if (isCustomer) {
    // in_progress, сторона заказчика — видит ход работ; «Сдать этап» и общая
    // зона загрузки — не её действие (это шаг исполнителя), но приложить
    // доказательство к пункту чек-листа реальный бэк не запрещает НИ ОДНОЙ
    // стороне (`upload_evidence`/`start`/`submit` проверяют только is_party,
    // не роль) — оставляем ту же строку чек-листа, что у исполнителя.
    body = (
      <>
        {err ? <Callout tone="warn">{err}</Callout> : null}
        <StartConditions
          title={t('stage.startConditionsTitle')}
          items={startConditionItems}
          stateLabels={startConditionLabels}
          openLabel={t('stage.openLabel')}
          onOpen={onOpenCondition}
        />
        <StageMaterials contractId={contractId} milestoneId={milestoneId} myRole={myRole} anchorId={MATERIALS_ANCHOR} />
        <div className={styles.card}>
          <h3 className={styles.sectionTitle}>{t('stage.checklistTitle')}</h3>
          {checklistItems.length > 0 ? (
            <AcceptanceChecklist items={checklistItems} attachLabel={t('stage.attach')} onAttach={onAttachToItem} />
          ) : (
            <EmptyState icon="checklist" title={t('stage.checklistTitle')} />
          )}
        </div>
        {evidenceCard}
      </>
    );
  } else {
    // in_progress — основной экран сдачи (исполнитель).
    body = (
      <>
        {err ? <Callout tone="warn">{err}</Callout> : null}

        <div className={styles.layout}>
          <div className={styles.left}>
            <StartConditions
              title={t('stage.startConditionsTitle')}
              items={startConditionItems}
              stateLabels={startConditionLabels}
              openLabel={t('stage.openLabel')}
              onOpen={onOpenCondition}
            />
            <StageMaterials contractId={contractId} milestoneId={milestoneId} myRole={myRole} anchorId={MATERIALS_ANCHOR} />
            <div className={styles.card}>
              <h3 className={styles.sectionTitle}>{t('stage.checklistTitle')}</h3>
              {checklistItems.length > 0 ? (
                <AcceptanceChecklist items={checklistItems} attachLabel={t('stage.attach')} onAttach={onAttachToItem} />
              ) : (
                <EmptyState icon="checklist" title={t('stage.checklistTitle')} />
              )}
            </div>
          </div>

          <div className={styles.right}>
            <div className={styles.card}>
              <h3 className={styles.sectionTitle}>{t('stage.uploaderTitle')}</h3>
              <EvidenceUploader
                dropLabel={t('stage.uploaderDropLabel')}
                browseLabel={t('stage.uploaderBrowseLabel')}
                bindLabel={t('stage.uploaderBindLabel')}
                bindHint={t('stage.uploaderBindHint')}
                bindOptions={bindOptions}
                bindValue={bindValue}
                onBindChange={setBindValue}
                onSelectFiles={onSelectFiles}
                cameraStubText={t('stage.cameraStubText')}
                errorText={uploadError ?? undefined}
                dismissErrorLabel={t('common.close')}
                onDismissError={() => setUploadError(null)}
              />
            </div>
            <div className={styles.card}>
              <h3 className={styles.sectionTitle}>{t('stage.evidenceTitle')}</h3>
              {/* До сдачи файлы ещё НА УСТРОЙСТВЕ (ADR-160) — про неизменность
                  говорим тогда, когда она уже наступила, иначе текст врёт. */}
              <Callout tone="neutral">{draftMode ? t('stage.draftHint') : t('stage.realEvidenceImmutableHint')}</Callout>
              <EvidenceList
                items={evidenceItems}
                emptyText={t('stage.evidenceEmpty')}
                onView={onViewItem}
                deleteLabel={t('stage.evidenceDelete')}
                onDelete={draftMode ? (id) => void drafts.remove(id) : undefined}
                retryLabel={t('stage.evidenceRetry')}
                onRetry={onRetryItem}
              />
            </div>
          </div>
        </div>

        <div className={styles.actionsBar}>
          {/* Пока черновик не прочитан из IndexedDB, сдавать нельзя: иначе
              «Сдать этап» ушёл бы без файлов, которые человек уже приложил. */}
          <Button
            variant="primary"
            block
            disabled={!inProgress || (draftMode && !drafts.ready)}
            onClick={() => {
              // Новый заход в диалог — без хвоста прошлой неудачной отправки
              // и без ошибки прошлой попытки (`setSubmitSheet` чистит `err`).
              setSendFailed(false);
              setSubmitSheet(true);
            }}
            data-testid="submit-stage-cta"
          >
            {t('stage.submitCta')}
          </Button>
          <span className={styles.actionsHint}>{t('stage.submitHint')}</span>
        </div>
      </>
    );
  }

  return (
    <div className={styles.wrap}>
      {header}
      {body}

      <SubmitStageSheet
        open={submitOpen}
        title={t('stage.submitSheetTitle')}
        onClose={() => setSubmitSheet(false)}
        closeLabel={t('common.close')}
        willHappenTitle={t('stage.submitWillHappenTitle')}
        items={[
          // «Будет отправлено N файлов» — первая строка списка: до этого момента
          // файлы никуда не уходили, человек должен видеть, сколько уйдёт.
          ...(draftMode && draftList.length > 0 ? [t('stage.draftWillSend', { count: draftList.length })] : []),
          t('stage.submitWillGo', { name: counterparty }),
          t('stage.submitWillLocked'),
        ]}
        confirmLabel={sendFailed ? t('stage.draftRetry') : t('stage.submitConfirm')}
        cancelLabel={t('common.cancel')}
        onConfirm={() => void onConfirmSubmit()}
        confirming={submit.isPending || sending !== null}
        progressText={sending ? t('stage.draftSending', { done: sending.done, total: sending.total }) : undefined}
        errorText={err ?? undefined}
        // ADR-164: непокрытые пункты — предупреждение, а не запрет. Кнопка
        // подтверждения остаётся активной: «сдать всё равно» — законный выбор.
        warningTitle={uncoveredLabels.length ? t('stage.submitNoEvidenceWarning') : undefined}
        warningItems={uncoveredLabels}
      />

      <SubmitStageSheet
        open={acceptOpen}
        title={t('stage.realAcceptSheetTitle')}
        onClose={() => setAcceptSheet(false)}
        closeLabel={t('common.close')}
        willHappenTitle={t('stage.submitWillHappenTitle')}
        items={[t('stage.realAcceptWillClose'), t('stage.realAcceptWillLocked')]}
        confirmLabel={t('stage.realAcceptConfirm')}
        cancelLabel={t('common.cancel')}
        onConfirm={() => void onConfirmAccept()}
        confirming={accept.isPending}
        errorText={err ?? undefined}
      />

      <PhotoViewer
        open={!!viewerFile}
        src={viewerFile?.src}
        name={viewerFile?.name}
        onClose={() => setViewerFile(null)}
        closeLabel={t('stage.photoClose')}
        fallbackText={viewerFile?.src ? undefined : t('stage.previewUnavailable')}
        downloadLabel={viewerFile?.evidenceId ? t('stage.downloadOriginal') : undefined}
        onDownload={viewerFile?.evidenceId ? () => void onDownloadEvidence() : undefined}
        downloading={downloading}
      />
    </div>
  );
}

/** Диспетчер real/мок — правило в `isRealContractId` (общее для карточки,
 * подписания и этапа). */
export function StagePage(): JSX.Element {
  const { id = '', sid = '' } = useParams();
  return isRealContractId(id) ? <RealStagePage contractId={id} milestoneId={sid} /> : <LegacyStagePage />;
}

/**
 * Сдача этапа + доказательства (DEV-11): `/contracts/:id/stages/:sid`. Роль — исполнитель
 * (гейт §1). «Ничего не требуем»: «Сдать этап» доступна всегда при `in_work` (§4 ⭐).
 */
function LegacyStagePage(): JSX.Element {
  const { t } = useTranslation();
  const { formatCountdown, formatDate, formatDateTime } = useFormatters();
  const navigate = useNavigate();
  const { id = '', sid = '' } = useParams();
  const viewAs = useViewerStore((s) => s.viewAs);
  const isContractor = viewAs === 'contractor';

  const { data, isPending, error, refetch } = useStageExecution(id, sid, isContractor);
  const { data: timeline } = useStageTimeline(id, sid, isContractor && !!data);
  const { data: drive } = useStageDriveBackup(isContractor);
  const connectDrive = useConnectStageDriveBackup();
  const stageApi = useStageExecutionApi(id, sid);

  const [bindValue, setBindValue] = useState('stage');
  const [pending, setPending] = useState<PendingUpload[]>([]);
  const [submitOpen, setSubmitOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [backupPromptOpen, setBackupPromptOpen] = useState(false);
  const [viewerFile, setViewerFile] = useState<{ src?: string; name: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);

  if (!isContractor) {
    return (
      <div className={styles.wrap}>
        <Callout tone="warn" title={t('stage.gateTitle')}>
          <Button variant="ghost" onClick={() => useViewerStore.getState().setViewAs('contractor')}>
            {t('stage.gateSwitch')}
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
          title={t('stage.errorText')}
          text={apiErrorText(error)}
          code={error instanceof ApiError ? error.code : undefined}
          retryLabel={t('common.retry')}
          onRetry={() => void refetch()}
        />
      </div>
    );
  }

  async function runUpload(tempId: string, file: File, bind: StageEvidenceBind): Promise<void> {
    setPending((p) => (p.some((x) => x.tempId === tempId) ? p.map((x) => (x.tempId === tempId ? { ...x, status: 'uploading', errorText: undefined } : x)) : [...p, { tempId, file, bind, status: 'uploading' }]));
    try {
      await stageApi.uploadEvidence(file, bind);
      setPending((p) => p.filter((x) => x.tempId !== tempId));
    } catch (e) {
      const message = stageErrorText(e, t);
      setPending((p) => p.map((x) => (x.tempId === tempId ? { ...x, status: 'error', errorText: message } : x)));
    }
  }

  function resolveBind(value: string): StageEvidenceBind {
    if (value === 'stage') return { kind: 'stage' };
    const item = data!.checklist.find((c) => c.id === value);
    return { kind: 'checklist_item', item_id: value, item_label: item?.label };
  }

  function onSelectFiles(files: File[]): void {
    const bind = resolveBind(bindValue);
    for (const file of files) {
      pendingSeq += 1;
      void runUpload(`pending-${pendingSeq}`, file, bind);
    }
  }

  function onAttachToItem(itemId: string, file: File): void {
    const item = data!.checklist.find((c) => c.id === itemId);
    pendingSeq += 1;
    void runUpload(`pending-${pendingSeq}`, file, { kind: 'checklist_item', item_id: itemId, item_label: item?.label });
  }

  async function onDelete(evidenceId: string): Promise<void> {
    setErr(null);
    try {
      await stageApi.deleteEvidence(evidenceId);
    } catch (e) {
      setErr(stageErrorText(e, t));
    }
  }

  async function onConfirmSubmit(): Promise<void> {
    setSubmitting(true);
    setSubmitError(null);
    try {
      const shouldPromptBackup = data!.first_submission && drive?.connected !== true;
      await stageApi.submit();
      setSubmitOpen(false);
      if (shouldPromptBackup) setBackupPromptOpen(true);
    } catch (e) {
      setSubmitError(stageErrorText(e, t));
    } finally {
      setSubmitting(false);
    }
  }

  async function onConnectDrive(): Promise<void> {
    try {
      await connectDrive.mutateAsync();
      setBackupPromptOpen(false);
    } catch {
      // Ошибка показана через connectDrive.isError — «Позже» остаётся доступно.
    }
  }

  function onOpenCondition(linkRef: string): void {
    const routes: Record<StageStartConditionLink, string> = {
      contract: `/contracts/${id}/overview`,
      materials: `/contracts/${id}/stages`,
      payment: `/contracts/${id}/money`,
    };
    navigate(routes[linkRef as StageStartConditionLink] ?? `/contracts/${id}`);
  }

  const startConditionItems: StartConditionItem[] = data.start_conditions.map((c) => ({
    key: c.key,
    label: c.label,
    state: c.state,
    sub: c.sub,
    linkRef: c.link_ref,
  }));
  const startConditionLabels: Record<StartConditionState, string> = {
    met: t('stage.startConditionMet'),
    waiting: t('stage.startConditionWaiting'),
    na: t('stage.startConditionNa'),
  };

  const checklistItems: StageChecklistItemView[] = data.checklist.map((c) => ({
    id: c.id,
    label: c.label,
    optional: c.optional,
    optionalLabel: c.optional ? t('stage.checklistOptional') : undefined,
    attachedLabel: c.evidence_ids.length > 0 ? t('stage.attachedCount', { count: c.evidence_ids.length }) : undefined,
  }));

  const evidenceItems: StageEvidenceItemView[] = [
    ...data.evidence.map(
      (e): StageEvidenceItemView => ({
        id: e.id,
        filename: e.filename,
        kind: e.mime.startsWith('image/') ? 'image' : 'doc',
        thumbUrl: e.thumb_url,
        status: e.status,
        uploadedLabel: t('stage.evidenceUploadedAt', { time: formatDateTime(e.uploaded_at) }),
        lateLabel: e.late_days ? t('stage.evidenceLate', { days: e.late_days }) : undefined,
        hashedLabel: e.integrity === 'hashed' ? t('stage.evidenceHashed') : undefined,
        bindLabel: e.bind.kind === 'stage' ? t('stage.evidenceBindStage') : t('stage.evidenceBindItem', { label: e.bind.item_label ?? '' }),
      }),
    ),
    ...pending.map(
      (p): StageEvidenceItemView => ({
        id: p.tempId,
        filename: p.file.name,
        kind: p.file.type.startsWith('image/') ? 'image' : 'doc',
        status: p.status === 'uploading' ? 'uploading' : 'stored',
        bindLabel: p.bind.kind === 'stage' ? t('stage.evidenceBindStage') : t('stage.evidenceBindItem', { label: p.bind.item_label ?? '' }),
        errorLabel: p.errorText,
      }),
    ),
  ];

  const bindOptions = [
    { id: 'stage', label: t('stage.uploaderBindStageOption') },
    ...data.checklist.map((c) => ({ id: c.id, label: c.label })),
  ];

  const inWork = data.status === 'in_work';
  const indexLabel = t('stage.stageOf', { index: data.index, total: data.total });
  const statusLabel = t(`stage.status${data.status === 'in_work' ? 'InWork' : data.status === 'suspended' ? 'Suspended' : data.status === 'under_acceptance' ? 'UnderAcceptance' : 'Accepted'}`);

  const header = (
    <StageHeader
      title={data.title}
      indexLabel={indexLabel}
      counterparty={data.counterparty}
      statusLabel={statusLabel}
      statusTone={STATUS_TONE[data.status] ?? 'neutral'}
      deadlineLabel={data.deadline ? `${t('stage.deadlineLabel')}: ${formatDate(data.deadline, { legal: true })}` : undefined}
      shifted={data.shifted}
      shiftedLabel={data.shifted ? t('stage.suspendedShifted') : undefined}
    />
  );

  let body: JSX.Element;

  if (data.status === 'suspended') {
    body = (
      <>
        <SuspendedBanner title={t('stage.suspendedTitle')} text={t('stage.suspendedText')} shiftedLabel={data.shifted ? t('stage.suspendedShifted') : undefined} />
        <StartConditions
          title={t('stage.startConditionsTitle')}
          items={startConditionItems}
          stateLabels={startConditionLabels}
          openLabel={t('stage.openLabel')}
          onOpen={onOpenCondition}
        />
        <div className={styles.actionsBar}>
          <Button variant="primary" block disabled data-testid="submit-stage-cta">
            {t('stage.submitCta')}
          </Button>
          <span className={styles.actionsHint}>{t('stage.submitSuspendedHint')}</span>
        </div>
      </>
    );
  } else if (data.status === 'accepted') {
    body = (
      <>
        <div className={styles.centeredState}>
          <Callout tone="neutral" title={t('stage.acceptedTitle')}>
            {t('stage.acceptedText')}
          </Callout>
        </div>
        <div className={styles.card}>
          <h3 className={styles.sectionTitle}>{t('stage.evidenceTitle')}</h3>
          <EvidenceList items={evidenceItems} emptyText={t('stage.evidenceEmpty')} onView={(f) => setViewerFile({ src: f.thumbUrl, name: f.filename })} deleteLabel={t('stage.evidenceDelete')} />
        </div>
      </>
    );
  } else if (data.status === 'under_acceptance' && data.acceptance) {
    body = (
      <>
        <AcceptanceTimer
          valueLabel={t('stage.timerValue', { time: formatCountdown(data.acceptance.auto_accept_at, Date.now()) })}
          hint={t('stage.timerHint', { date: formatDate(data.acceptance.auto_accept_at, { legal: true }) })}
        />
        <div className={styles.card}>
          <h3 className={styles.sectionTitle}>{t('stage.evidenceTitle')}</h3>
          <EvidenceList items={evidenceItems} emptyText={t('stage.evidenceEmpty')} onView={(f) => setViewerFile({ src: f.thumbUrl, name: f.filename })} deleteLabel={t('stage.evidenceDelete')} />
        </div>
        {timeline && timeline.length > 0 ? (
          <div className={styles.card}>
            <ContractTimeline events={timeline.map((e) => ({ id: e.id, title: e.text, at: formatDateTime(e.at), done: true }))} />
          </div>
        ) : null}
      </>
    );
  } else {
    // in_work — основной экран сдачи.
    body = (
      <>
        {err ? <Callout tone="warn">{err}</Callout> : null}

        <div className={styles.layout}>
          <div className={styles.left}>
            <StartConditions
              title={t('stage.startConditionsTitle')}
              items={startConditionItems}
              stateLabels={startConditionLabels}
              openLabel={t('stage.openLabel')}
              onOpen={onOpenCondition}
            />
            <div className={styles.card}>
              <h3 className={styles.sectionTitle}>{t('stage.checklistTitle')}</h3>
              {checklistItems.length > 0 ? (
                <AcceptanceChecklist items={checklistItems} attachLabel={t('stage.attach')} onAttach={onAttachToItem} />
              ) : (
                <EmptyState icon="checklist" title={t('stage.checklistTitle')} />
              )}
            </div>
          </div>

          <div className={styles.right}>
            <div className={styles.card}>
              <h3 className={styles.sectionTitle}>{t('stage.uploaderTitle')}</h3>
              <EvidenceUploader
                dropLabel={t('stage.uploaderDropLabel')}
                browseLabel={t('stage.uploaderBrowseLabel')}
                bindLabel={t('stage.uploaderBindLabel')}
                bindHint={t('stage.uploaderBindHint')}
                bindOptions={bindOptions}
                bindValue={bindValue}
                onBindChange={setBindValue}
                onSelectFiles={onSelectFiles}
                cameraStubText={t('stage.cameraStubText')}
              />
            </div>
            <div className={styles.card}>
              <h3 className={styles.sectionTitle}>{t('stage.evidenceTitle')}</h3>
              <EvidenceList
                items={evidenceItems}
                emptyText={t('stage.evidenceEmpty')}
                onView={(f) => setViewerFile({ src: f.thumbUrl, name: f.filename })}
                onDelete={(evId) => void onDelete(evId)}
                deleteLabel={t('stage.evidenceDelete')}
                retryLabel={t('stage.evidenceRetry')}
                onRetry={(tempId) => {
                  const p = pending.find((x) => x.tempId === tempId);
                  if (p) void runUpload(tempId, p.file, p.bind);
                }}
              />
            </div>
            <StoragePlashka
              tone={drive?.connected ? 'ok' : 'info'}
              title={drive?.connected ? t('stage.storageOkTitle') : t('stage.storageInfoTitle')}
              text={drive?.connected ? t('stage.storageOkText') : t('stage.storageInfoText')}
              connectLabel={t('stage.storageConnect')}
              onConnect={() => void connectDrive.mutateAsync()}
              loading={connectDrive.isPending}
              connectedBadge={t('stage.storageConnectedBadge')}
            />
          </div>
        </div>

        <div className={styles.actionsBar}>
          <Button
            variant="primary"
            block
            disabled={!inWork}
            onClick={() => {
              // ADR-164: диалог открывается чистым — иначе прошлая ошибка
              // висит в нём ещё до запроса (жалоба 05.09).
              setSubmitError(null);
              setSubmitOpen(true);
            }}
            data-testid="submit-stage-cta"
          >
            {t('stage.submitCta')}
          </Button>
          <span className={styles.actionsHint}>{t('stage.submitHint')}</span>
        </div>
      </>
    );
  }

  return (
    <div className={styles.wrap}>
      {header}
      {body}

      <SubmitStageSheet
        open={submitOpen}
        title={t('stage.submitSheetTitle')}
        onClose={() => {
          setSubmitError(null);
          setSubmitOpen(false);
        }}
        closeLabel={t('common.close')}
        willHappenTitle={t('stage.submitWillHappenTitle')}
        items={[
          t('stage.submitWillGo', { name: data.counterparty }),
          t('stage.submitWillTimer', { days: 5 }),
          t('stage.submitWillLocked'),
        ]}
        confirmLabel={t('stage.submitConfirm')}
        cancelLabel={t('common.cancel')}
        onConfirm={() => void onConfirmSubmit()}
        confirming={submitting}
        errorText={submitError ?? undefined}
      />

      <DriveBackupPrompt
        open={backupPromptOpen}
        title={t('stage.backupPromptTitle')}
        text={t('stage.backupPromptText')}
        connectLabel={t('stage.backupPromptConnect')}
        laterLabel={t('stage.backupPromptLater')}
        closeLabel={t('common.close')}
        onConnect={() => void onConnectDrive()}
        onLater={() => setBackupPromptOpen(false)}
        connecting={connectDrive.isPending}
        errorText={connectDrive.isError ? t('stage.storageError') : undefined}
      />

      <PhotoViewer open={!!viewerFile} src={viewerFile?.src} name={viewerFile?.name} onClose={() => setViewerFile(null)} closeLabel={t('stage.photoClose')} />
    </div>
  );
}
