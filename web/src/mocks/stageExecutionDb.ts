/**
 * Мок-стор сдачи этапа (DEV-11). Отдельная от contractsDb (Ф2, дерево этапов) и от
 * acceptanceDb (DEV-04, приёмка заказчиком) проекция — экран ИСПОЛНИТЕЛЯ: загрузка
 * доказательств + формальная сдача. Симметрия с DEV-04: то же доказательство заказчик
 * увидит на приёмке (вне скоупа этого мока — отдельный экран №4).
 */
import type {
  StageChecklistItem,
  StageEvidence,
  StageEvidenceUploadInput,
  StageExecutionDetail,
  StageStartCondition,
  StageTimelineEvent,
} from '@porukam/core';
import { MockError } from './contractsDb';

/** Срок приёмки после сдачи (§4/§8 «Начнётся срок приёмки — N дней») — фиксированный мок-дефолт. */
const ACCEPTANCE_WINDOW_DAYS = 5;

interface MockStage extends StageExecutionDetail {
  timeline: StageTimelineEvent[];
}

let evidenceSeq = 100;
let timelineSeq = 100;

function iso(deltaMs: number): string {
  return new Date(Date.now() + deltaMs).toISOString();
}

const DAY = 24 * 60 * 60 * 1000;

function conditions(overrides: Partial<Record<string, StageStartCondition>> = {}): StageStartCondition[] {
  const base: StageStartCondition[] = [
    { key: 'contract_signed', label: 'Договор подписан', state: 'met', link_ref: 'contract' },
    { key: 'materials', label: 'Материалы получены', state: 'met', sub: '5 из 5 позиций', link_ref: 'materials' },
    { key: 'advance', label: 'Аванс получен', state: 'na' },
    { key: 'access', label: 'Доступ к объекту', state: 'met' },
  ];
  return base.map((c) => overrides[c.key] ?? c);
}

function checklist(): StageChecklistItem[] {
  return [
    { id: 'sci-1', label: 'Плитка уложена по всей площади', optional: false, evidence_ids: [] },
    { id: 'sci-2', label: 'Швы затёрты', optional: false, evidence_ids: [] },
    { id: 'sci-3', label: 'Мусор и упаковка вывезены', optional: true, evidence_ids: [] },
  ];
}

function seed(): MockStage[] {
  return [
    // (a) in_work без доказательств — сдача доступна, мягкая подсказка. (c) Drive off + первая сдача.
    {
      id: 'st-9101',
      contract_id: 'c-9101',
      index: 3,
      total: 5,
      title: 'Укладка плитки в санузле',
      status: 'in_work',
      viewer_role: 'performer',
      counterparty: 'Заказчик Анна Свет (@anna_svet)',
      deadline: iso(6 * DAY),
      duration_days: 7,
      shifted: false,
      start_conditions: conditions(),
      checklist: checklist(),
      evidence: [],
      acceptance: null,
      drive_backup: 'off',
      first_submission: true,
      timeline: [],
    },
    // (b) in_work с 2–3 доказательствами (одно late_days:2, привязки к пунктам + к этапу). (d) Drive connected.
    {
      id: 'st-9102',
      contract_id: 'c-9102',
      index: 2,
      total: 4,
      title: 'Электромонтаж, комната 2',
      status: 'in_work',
      viewer_role: 'performer',
      counterparty: 'Заказчик Игорь Волков (@i_volkov)',
      deadline: iso(3 * DAY),
      duration_days: 5,
      shifted: false,
      start_conditions: conditions(),
      checklist: (() => {
        const items = checklist();
        items[0]!.evidence_ids = ['sev-1'];
        items[1]!.evidence_ids = ['sev-2'];
        return items;
      })(),
      evidence: [
        {
          id: 'sev-1',
          filename: 'Розетки установлены.jpg',
          mime: 'image/jpeg',
          size: 240_000,
          thumb_url: 'https://placehold.co/480x360',
          uploaded_at: iso(-2 * DAY),
          integrity: 'hashed',
          bind: { kind: 'checklist_item', item_id: 'sci-1', item_label: 'Плитка уложена по всей площади' },
          status: 'stored',
        },
        {
          id: 'sev-2',
          filename: 'Щиток подключён.jpg',
          mime: 'image/jpeg',
          size: 198_000,
          thumb_url: 'https://placehold.co/480x360',
          uploaded_at: iso(-1 * DAY),
          integrity: 'hashed',
          late_days: 2,
          bind: { kind: 'checklist_item', item_id: 'sci-2', item_label: 'Швы затёрты' },
          status: 'stored',
        },
        {
          id: 'sev-3',
          filename: 'Акт расхода материалов.pdf',
          mime: 'application/pdf',
          size: 52_000,
          uploaded_at: iso(-1 * DAY),
          integrity: 'hashed',
          bind: { kind: 'stage' },
          status: 'stored',
        },
      ],
      acceptance: null,
      drive_backup: 'connected',
      first_submission: false,
      timeline: [
        { id: 'stl-1', at: iso(-2 * DAY), text: 'Загружено доказательство «Розетки установлены.jpg»' },
        { id: 'stl-2', at: iso(-1 * DAY), text: 'Загружено доказательство «Щиток подключён.jpg»' },
      ],
    },
    // (e) under_acceptance — таймер, авто-приёмка.
    {
      id: 'st-9103',
      contract_id: 'c-9103',
      index: 1,
      total: 3,
      title: 'Демонтаж старого покрытия',
      status: 'under_acceptance',
      viewer_role: 'performer',
      counterparty: 'Заказчик Дмитрий Косяк (@d_kosyak)',
      deadline: iso(-1 * DAY),
      duration_days: 3,
      shifted: false,
      start_conditions: conditions(),
      checklist: checklist(),
      evidence: [
        {
          id: 'sev-4',
          filename: 'Демонтаж завершён.jpg',
          mime: 'image/jpeg',
          size: 210_000,
          thumb_url: 'https://placehold.co/480x360',
          uploaded_at: iso(-0.2 * DAY),
          integrity: 'hashed',
          bind: { kind: 'stage' },
          status: 'stored',
        },
      ],
      acceptance: { timer_ends_at: iso(ACCEPTANCE_WINDOW_DAYS * DAY - 0.2 * DAY), auto_accept_at: iso(ACCEPTANCE_WINDOW_DAYS * DAY - 0.2 * DAY) },
      drive_backup: 'connected',
      first_submission: false,
      timeline: [
        { id: 'stl-3', at: iso(-0.2 * DAY), text: 'Загружено доказательство «Демонтаж завершён.jpg»' },
        { id: 'stl-4', at: iso(-0.1 * DAY), text: 'Этап сдан — уходит на приёмку' },
      ],
    },
    // (f) suspended — ждём материалы/доступ, срок сдвинут.
    {
      id: 'st-9104',
      contract_id: 'c-9104',
      index: 4,
      total: 6,
      title: 'Монтаж кухонного гарнитура',
      status: 'suspended',
      viewer_role: 'performer',
      counterparty: 'Заказчик Николай Гром (@grom_master)',
      deadline: iso(9 * DAY),
      duration_days: 4,
      shifted: true,
      start_conditions: conditions({
        materials: { key: 'materials', label: 'Материалы получены', state: 'waiting', sub: '2 из 5 позиций', link_ref: 'materials' },
      }),
      checklist: checklist(),
      evidence: [],
      acceptance: null,
      drive_backup: 'off',
      first_submission: true,
      timeline: [],
    },
    // (g) accepted — итог.
    {
      id: 'st-9105',
      contract_id: 'c-9105',
      index: 5,
      total: 5,
      title: 'Финальная уборка объекта',
      status: 'accepted',
      viewer_role: 'performer',
      counterparty: 'Заказчик Анна Свет (@anna_svet)',
      deadline: iso(-4 * DAY),
      duration_days: 1,
      shifted: false,
      start_conditions: conditions(),
      checklist: checklist(),
      evidence: [
        {
          id: 'sev-5',
          filename: 'Объект убран.jpg',
          mime: 'image/jpeg',
          size: 180_000,
          thumb_url: 'https://placehold.co/480x360',
          uploaded_at: iso(-5 * DAY),
          integrity: 'hashed',
          bind: { kind: 'stage' },
          status: 'stored',
        },
      ],
      acceptance: null,
      drive_backup: 'connected',
      first_submission: false,
      timeline: [
        { id: 'stl-5', at: iso(-5 * DAY), text: 'Загружено доказательство «Объект убран.jpg»' },
        { id: 'stl-6', at: iso(-4.5 * DAY), text: 'Этап сдан — уходит на приёмку' },
        { id: 'stl-7', at: iso(-4 * DAY), text: 'Этап принят заказчиком' },
      ],
    },
  ];
}

let items: MockStage[] = seed();

/**
 * Drive-бэкап — настройка уровня аккаунта (ADR-060 §8), не этапа: один переключатель
 * на пользователя, `stage.drive_backup` в ответе — снимок этого состояния на момент
 * запроса. `/v1/me/drive-backup` — МОК-ТОЛЬКО (реальная интеграция Drive — ГВ.3, §11);
 * НЕ путать с `/v1/users/me/drive-backup` (DEV-auth-onboarding, GLOBAL-сессия) — тот
 * гейтится Google-входом и недоступен OTP-пользователям демо-потока.
 */
let driveBackupConnected = false;

export function resetStageExecution(): void {
  items = seed();
  evidenceSeq = 100;
  timelineSeq = 100;
  driveBackupConnected = false;
}

function find(contractId: string, stageId: string): MockStage {
  const s = items.find((x) => x.contract_id === contractId && x.id === stageId);
  if (!s) throw new MockError(404, 'not_found', 'Этап не найден.');
  return s;
}

export function getStageExecution(contractId: string, stageId: string): StageExecutionDetail {
  const { timeline: _timeline, ...detail } = find(contractId, stageId);
  return { ...detail, drive_backup: driveBackupConnected ? 'connected' : 'off' };
}

export function getStageDriveBackup(): { connected: boolean } {
  return { connected: driveBackupConnected };
}

export function connectStageDriveBackup(): { connected: boolean } {
  driveBackupConnected = true;
  return { connected: driveBackupConnected };
}

export function getStageTimeline(contractId: string, stageId: string): StageTimelineEvent[] {
  return find(contractId, stageId).timeline;
}

function assertInWork(s: MockStage): void {
  if (s.status === 'suspended') {
    throw new MockError(409, 'stage_suspended', 'Этап приостановлен — сначала снимите приостановку.');
  }
  if (s.status !== 'in_work') {
    throw new MockError(409, 'invalid_state_transition', 'Этап уже сдан — доказательства неизменны.');
  }
}

/** Мок без реального multipart (§0 архитектура) — файл описывается метаданными, не байтами. */
export function uploadStageEvidence(contractId: string, stageId: string, input: StageEvidenceUploadInput): StageEvidence {
  const s = find(contractId, stageId);
  assertInWork(s);
  // Детерминированный триггер ошибки загрузки для тестов/Storybook (§9 сценарий 8 — «загрузка с ошибкой → повтор»).
  if (/fail/i.test(input.filename)) {
    throw new MockError(500, 'upload_failed', 'Не удалось загрузить файл. Попробуйте ещё раз.');
  }
  evidenceSeq += 1;
  const id = `sev-${evidenceSeq}`;
  const isImage = /\.(jpe?g|png|gif|webp)$/i.test(input.filename);
  const uploadedAt = new Date();
  // Поздняя загрузка — эвристика мока: сдвиг дедлайна назад уже прошёл (нейтральный факт, не наказание).
  const lateDays = s.deadline && new Date(s.deadline).getTime() < uploadedAt.getTime() ? Math.max(1, Math.ceil((uploadedAt.getTime() - new Date(s.deadline).getTime()) / DAY)) : undefined;
  const evidence: StageEvidence = {
    id,
    filename: input.filename,
    mime: input.mime,
    size: input.size,
    thumb_url: isImage ? 'https://placehold.co/480x360' : undefined,
    uploaded_at: uploadedAt.toISOString(),
    integrity: 'hashed',
    late_days: lateDays,
    bind: input.bind,
    status: 'stored',
  };
  s.evidence.push(evidence);
  if (input.bind.kind === 'checklist_item' && input.bind.item_id) {
    const item = s.checklist.find((c) => c.id === input.bind.item_id);
    item?.evidence_ids.push(id);
  }
  timelineSeq += 1;
  s.timeline.push({ id: `stl-${timelineSeq}`, at: evidence.uploaded_at, text: `Загружено доказательство «${input.filename}»` });
  return evidence;
}

export function deleteStageEvidence(contractId: string, stageId: string, evidenceId: string): void {
  const s = find(contractId, stageId);
  assertInWork(s);
  const idx = s.evidence.findIndex((e) => e.id === evidenceId);
  if (idx === -1) throw new MockError(404, 'not_found', 'Доказательство не найдено.');
  const [removed] = s.evidence.splice(idx, 1);
  for (const item of s.checklist) {
    item.evidence_ids = item.evidence_ids.filter((id) => id !== evidenceId);
  }
  timelineSeq += 1;
  s.timeline.push({ id: `stl-${timelineSeq}`, at: new Date().toISOString(), text: `Удалено доказательство «${removed?.filename ?? evidenceId}»` });
}

export function submitStage(contractId: string, stageId: string): StageExecutionDetail {
  const s = find(contractId, stageId);
  assertInWork(s);
  const endsAt = iso(ACCEPTANCE_WINDOW_DAYS * DAY);
  s.status = 'under_acceptance';
  s.acceptance = { timer_ends_at: endsAt, auto_accept_at: endsAt };
  timelineSeq += 1;
  s.timeline.push({ id: `stl-${timelineSeq}`, at: new Date().toISOString(), text: 'Этап сдан — уходит на приёмку' });
  const { timeline: _timeline, ...detail } = s;
  return { ...detail, drive_backup: driveBackupConnected ? 'connected' : 'off' };
}
