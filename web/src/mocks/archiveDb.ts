/**
 * Мок-стор экспорта архива сделки — контракт `apps.archive` (ADR-139, DEV-12 §12).
 * Отдельная от contractsDb проекция: снимок состава сделки, экспорты и
 * долгоживущие ссылки сторон. Асинхронная сборка — sweep-on-read (тот же приём,
 * что paymentsDb: `readyAt` сравнивается с `Date.now()` на чтении, не реальный
 * фоновый таймер, §3 CLAUDE.md): `queued` → `running` → `ready|failed`.
 *
 * Роль вызывающего в моке — всегда `customer` (ME): ссылки заказчика — с `url`,
 * ссылки исполнителя — `url: null` (чужой токен не показывается, ADR-139 §7).
 */
import type {
  ArchiveContractStatus,
  ArchiveLink,
  ArchiveLinkKind,
  ArchivePreview,
  ArchiveRetention,
  ArchiveSection,
  ContractRole,
  ExportAccepted,
  ExportJob,
  ExportOptionsInput,
} from '@porukam/core';
import { MockError, ME_BIZ, ME_PERSON, db } from './contractsDb';
import { buildTree, getContract, listEvidence, listTimeline } from './realContractsDb';
import { getProfileSettings } from './profilesDb';

/** Ускоренный демо-таймер сборки (секунды, не минуты — §3 CLAUDE.md). */
const EXPORT_DELAY_MS = 1_400;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Роль вызывающего в моке (X-Acting-Profile не различаем: обе демо-персоны — заказчик сидов). */
const ME_ROLE: ContractRole = 'customer';

interface StoredLink {
  id: string;
  exportId: string;
  kind: ArchiveLinkKind;
  party_role: ContractRole;
  token: string;
  created_at: string;
  revoked_at: string | null;
  last_access_at: string | null;
  access_count: number;
}

interface StoredExport {
  id: string;
  contractId: string;
  createdAt: number;
  readyAt: number;
  willFail: boolean;
  trigger: ExportJob['trigger'];
  isSnapshot: boolean;
  snapshotAt: string;
  includeOriginals: boolean;
  manifestOnly: boolean;
  evidenceCount: number;
  packageSize: number;
  filesSize: number;
  filesState: 'pending' | 'available' | 'shredded' | 'not_requested';
  filesShreddedAt: string | null;
  filesExpiresAt: string | null;
  links: StoredLink[];
}

type SeedPreview = Omit<ArchivePreview, 'exports'>;

const iso = (ms: number): string => new Date(ms).toISOString();
const fakeSha = (seed: string): string => {
  let h = 0;
  for (const ch of seed) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h.toString(16).padStart(8, '0').repeat(8);
};
const linkUrl = (token: string): string => `${typeof location !== 'undefined' ? location.origin : 'http://localhost'}/a/${token}`;

function retentionFor(state: ArchiveRetention['state'], anchoredMs: number, paused = false): ArchiveRetention {
  if (state === null) return { state: null, anchored_at: null, hot_until: null, archive_until: null };
  return {
    state,
    anchored_at: iso(anchoredMs),
    hot_until: iso(anchoredMs + 90 * DAY_MS),
    archive_until: iso(anchoredMs + 365 * DAY_MS),
    paused,
  };
}

const NOW = Date.now();

function seedPreviews(): SeedPreview[] {
  return [
    // (a) закрытый договор: автоэкспорт при завершении, файлы доступны, обе ссылки живы.
    {
      contract_id: 'c-9301',
      contract_no: '№ 2026-0301',
      counterparty: 'Мастер Ремонт (@masterremont)',
      contract_status: 'closed',
      is_snapshot: false,
      snapshot_at: null,
      sections: [
        { key: 'contract', count: 2, size_bytes: null, complete: true },
        { key: 'milestones', count: 5, size_bytes: null, complete: true },
        { key: 'events', count: 24, size_bytes: null, complete: true },
        { key: 'evidence', count: 9, size_bytes: 18_600_000, complete: true },
        { key: 'payments', count: 5, size_bytes: null, complete: true },
      ] satisfies ArchiveSection[],
      format: { pdf: false, zip: true, html: true },
      est_size_bytes: 18_600_000,
      drive_backup: 'off',
      can_export: true,
      retention: retentionFor('hot', NOW - 20 * DAY_MS),
    },
    // (b) закрытый давно: срок хранения вышел — `files.zip` удалён, пакет с хешами доступен.
    {
      contract_id: 'c-9302',
      contract_no: '№ 2026-0302',
      counterparty: 'Николай Гром (@grom_master)',
      contract_status: 'closed',
      is_snapshot: false,
      snapshot_at: null,
      sections: [
        { key: 'contract', count: 1, size_bytes: null, complete: true },
        { key: 'milestones', count: 3, size_bytes: null, complete: true },
        { key: 'events', count: 14, size_bytes: null, complete: true },
        { key: 'evidence', count: 6, size_bytes: 640_000, complete: true },
        { key: 'payments', count: 3, size_bytes: null, complete: true },
      ] satisfies ArchiveSection[],
      format: { pdf: false, zip: true, html: true },
      est_size_bytes: 640_000,
      drive_backup: 'off',
      can_export: true,
      retention: retentionFor('shredded', NOW - 400 * DAY_MS),
    },
    // (c) in_work → снимок, частичные секции, открыт спор.
    {
      contract_id: 'c-9303',
      contract_no: '№ 2026-0303',
      counterparty: 'Дмитрий Косяк (@d_kosyak)',
      contract_status: 'in_work',
      is_snapshot: true,
      snapshot_at: iso(NOW),
      sections: [
        { key: 'contract', count: 1, size_bytes: null, complete: true },
        { key: 'milestones', count: 5, size_bytes: null, complete: false },
        { key: 'events', count: 9, size_bytes: null, complete: false },
        { key: 'evidence', count: 3, size_bytes: 5_400_000, complete: false },
        { key: 'payments', count: 5, size_bytes: null, complete: false },
        { key: 'dispute', count: 1, size_bytes: null, complete: false },
      ] satisfies ArchiveSection[],
      format: { pdf: false, zip: true, html: true },
      est_size_bytes: 5_400_000,
      drive_backup: 'off',
      can_export: true,
      retention: retentionFor(null, NOW),
    },
    // (d) черновик ни разу не заморожен → собирать нечего (409 на POST).
    {
      contract_id: 'c-9304',
      contract_no: '№ 2026-0304',
      counterparty: 'Анна Свет (@anna_svet)',
      contract_status: 'in_work',
      is_snapshot: true,
      snapshot_at: iso(NOW),
      sections: [
        { key: 'contract', count: 0, size_bytes: null, complete: false },
        { key: 'milestones', count: 0, size_bytes: null, complete: false },
        { key: 'events', count: 1, size_bytes: null, complete: false },
        { key: 'evidence', count: 0, size_bytes: 0, complete: false },
        { key: 'payments', count: 0, size_bytes: null, complete: false },
      ] satisfies ArchiveSection[],
      format: { pdf: false, zip: true, html: true },
      est_size_bytes: 0,
      drive_backup: 'off',
      can_export: false,
      retention: retentionFor(null, NOW),
    },
    // (f) закрытый — сборка всегда завершается ошибкой (детерминированный демо-триггер).
    {
      contract_id: 'c-9305',
      contract_no: '№ 2026-0305',
      counterparty: 'Игорь Волков (@i_volkov)',
      contract_status: 'closed',
      is_snapshot: false,
      snapshot_at: null,
      sections: [
        { key: 'contract', count: 1, size_bytes: null, complete: true },
        { key: 'milestones', count: 4, size_bytes: null, complete: true },
        { key: 'events', count: 16, size_bytes: null, complete: true },
        { key: 'evidence', count: 5, size_bytes: 3_200_000, complete: true },
        { key: 'payments', count: 4, size_bytes: null, complete: true },
      ] satisfies ArchiveSection[],
      format: { pdf: false, zip: true, html: true },
      est_size_bytes: 3_200_000,
      drive_backup: 'off',
      can_export: true,
      retention: retentionFor('hot', NOW - 5 * DAY_MS, true),
    },
  ];
}

let previews: SeedPreview[] = seedPreviews();
let exportsStore: StoredExport[] = [];
let seq = 100;
const nextId = (prefix: string): string => `${prefix}-${++seq}`;

function makeLinks(exportId: string, createdAt: string, kinds: ArchiveLinkKind[]): StoredLink[] {
  const roles: ContractRole[] = ['customer', 'contractor'];
  const out: StoredLink[] = [];
  for (const kind of kinds) {
    for (const role of roles) {
      const id = nextId('al');
      out.push({ id, exportId, kind, party_role: role, token: `tok-${id}`, created_at: createdAt, revoked_at: null, last_access_at: null, access_count: 0 });
    }
  }
  return out;
}

/** Готовые сиды: автоэкспорт при завершении сделки (ADR-139 §6) — на (a) и (b). */
function seedExports(): StoredExport[] {
  const a = NOW - 20 * DAY_MS;
  const b = NOW - 400 * DAY_MS;
  const expA: StoredExport = {
    id: 'exp-auto-9301',
    contractId: 'c-9301',
    createdAt: a,
    readyAt: a + 60_000,
    willFail: false,
    trigger: 'auto',
    isSnapshot: false,
    snapshotAt: iso(a),
    includeOriginals: true,
    manifestOnly: false,
    evidenceCount: 9,
    packageSize: 84_300,
    filesSize: 18_600_000,
    filesState: 'available',
    filesShreddedAt: null,
    filesExpiresAt: iso(a + 365 * DAY_MS),
    links: makeLinks('exp-auto-9301', iso(a + 60_000), ['package', 'files']),
  };
  expA.links[0]!.access_count = 2;
  expA.links[0]!.last_access_at = iso(NOW - 3 * DAY_MS);
  expA.links[1]!.access_count = 1;
  expA.links[1]!.last_access_at = iso(NOW - 10 * DAY_MS);
  const expB: StoredExport = {
    id: 'exp-auto-9302',
    contractId: 'c-9302',
    createdAt: b,
    readyAt: b + 60_000,
    willFail: false,
    trigger: 'auto',
    isSnapshot: false,
    snapshotAt: iso(b),
    includeOriginals: true,
    manifestOnly: false,
    evidenceCount: 6,
    packageSize: 61_900,
    filesSize: 640_000,
    filesState: 'shredded',
    filesShreddedAt: iso(b + 365 * DAY_MS),
    filesExpiresAt: iso(b + 365 * DAY_MS),
    links: makeLinks('exp-auto-9302', iso(b + 60_000), ['package', 'files']),
  };
  return [expA, expB];
}

export function resetArchive(): void {
  previews = seedPreviews();
  seq = 100;
  exportsStore = seedExports();
}
resetArchive();

/**
 * Превью для «живых» договоров (старый агрегат contractsDb `c-3001…` и реальный
 * контур realContractsDb `rc-*`): бэк строит архив из данных самой сделки,
 * поэтому 404 — только на действительно несуществующий id.
 */
function previewFromLegacy(contractId: string): SeedPreview | null {
  let c;
  try {
    c = db.get(contractId);
  } catch {
    return null;
  }
  const counterparty = c.parties.find((p) => p.handle !== ME_PERSON.handle && p.handle !== ME_BIZ.handle);
  const leaves = c.milestones.filter((m) => m.kind === 'leaf');
  const accepted = leaves.filter((m) => m.status === 'accepted' || m.status === 'paid').length;
  const evidenceCount = c.milestones.reduce((n, m) => n + m.materials.length, 0);
  const terminated = c.execution === 'terminated_by_customer' || c.execution === 'terminated_by_contractor';
  const closed = c.execution === 'completed' || c.execution === 'under_warranty';
  const status: ArchiveContractStatus = terminated ? 'terminated' : closed ? 'closed' : 'in_work';
  const ended = status !== 'in_work';
  return {
    contract_id: c.id,
    contract_no: c.no ?? `№ ${c.id}`,
    counterparty: counterparty ? `${counterparty.display_name} (${counterparty.handle})` : '',
    contract_status: status,
    is_snapshot: !ended,
    snapshot_at: ended ? null : iso(NOW),
    sections: [
      { key: 'contract', count: c.version ? 1 : 0, size_bytes: null, complete: !!c.version },
      { key: 'milestones', count: leaves.length, size_bytes: null, complete: ended || (leaves.length > 0 && accepted === leaves.length) },
      { key: 'events', count: c.timeline.length, size_bytes: null, complete: ended },
      { key: 'evidence', count: evidenceCount, size_bytes: evidenceCount * 1_800_000, complete: ended },
      { key: 'payments', count: leaves.length, size_bytes: null, complete: ended },
    ],
    format: { pdf: false, zip: true, html: true },
    est_size_bytes: evidenceCount * 1_800_000,
    drive_backup: 'off',
    // Черновик без заморозки — собирать нечего (409 на POST).
    can_export: !!c.version,
    retention: retentionFor(ended ? 'hot' : null, NOW - DAY_MS),
  };
}

function previewFromReal(contractId: string): SeedPreview | null {
  let c;
  try {
    c = getContract(contractId);
  } catch {
    return null;
  }
  const tree = buildTree(contractId);
  const flat: { id: string; status: string }[] = [];
  const walk = (nodes: typeof tree): void => {
    for (const n of nodes) {
      flat.push({ id: n.id, status: n.status });
      walk(n.children);
    }
  };
  walk(tree);
  const accepted = flat.filter((n) => n.status === 'accepted' || n.status === 'paid').length;
  const evidence = flat.flatMap((n) => listEvidence(n.id));
  const evidenceSize = evidence.reduce((s, e) => s + (e.file_size ?? 0), 0);
  const ex = c.execution_status;
  const terminated = ex === 'terminated_by_customer' || ex === 'terminated_by_contractor';
  const ended = terminated || ex === 'completed' || ex === 'warranty' || ex === 'closed';
  const status: ArchiveContractStatus = terminated ? 'terminated' : ended ? 'closed' : 'in_work';
  const other = c.parties.find((p) => p.profile_id !== 'pf-person-1' && p.profile_id !== 'pf-biz-1') ?? c.parties[1];
  const counterparty = (other && getProfileSettings(other.profile_id)?.display_name) || '';
  const hasVersion = !!c.frozen_version_id || c.negotiation_status === 'signed';
  const sections: ArchiveSection[] = [
    { key: 'contract', count: hasVersion ? 1 : 0, size_bytes: null, complete: c.negotiation_status === 'signed' },
    { key: 'milestones', count: flat.length, size_bytes: null, complete: ended || (flat.length > 0 && accepted === flat.length) },
    { key: 'events', count: listTimeline(contractId).length, size_bytes: null, complete: ended },
    { key: 'evidence', count: evidence.length, size_bytes: evidenceSize, complete: ended },
    { key: 'payments', count: 0, size_bytes: null, complete: ended },
  ];
  if (flat.some((n) => n.status === 'disputed')) sections.push({ key: 'dispute', count: 1, size_bytes: null, complete: false });
  return {
    contract_id: c.id,
    contract_no: `№ ${c.id.replace(/-/g, '').slice(-6).toUpperCase()}`,
    counterparty,
    contract_status: status,
    is_snapshot: !ended,
    snapshot_at: ended ? null : iso(NOW),
    sections,
    format: { pdf: false, zip: true, html: true },
    est_size_bytes: evidenceSize,
    drive_backup: 'off',
    can_export: hasVersion,
    retention: retentionFor(ended ? 'hot' : null, NOW - DAY_MS),
  };
}

function findPreview(contractId: string): SeedPreview {
  const p = previews.find((x) => x.contract_id === contractId) ?? (contractId.startsWith('rc-') ? previewFromReal(contractId) : previewFromLegacy(contractId));
  if (!p) throw new MockError(404, 'not_found', 'Договор не найден.');
  return p;
}

function linkView(link: StoredLink): ArchiveLink {
  const mine = link.party_role === ME_ROLE && link.revoked_at === null;
  return {
    id: link.id,
    kind: link.kind,
    party_role: link.party_role,
    url: mine ? linkUrl(link.token) : null,
    created_at: link.created_at,
    revoked_at: link.revoked_at,
    last_access_at: link.last_access_at,
    access_count: link.access_count,
  };
}

/** Sweep-on-read: доводим экспорт до ready/failed, когда подошло время; ссылки
 * создаются при первой готовности (у бэка — задачей `deliver_export`). */
function toJob(e: StoredExport): ExportJob {
  const now = Date.now();
  const elapsed = now - e.createdAt;
  const span = e.readyAt - e.createdAt;
  let status: ExportJob['status'];
  if (now < e.readyAt) status = elapsed < span * 0.35 ? 'queued' : 'running';
  else status = e.willFail ? 'failed' : 'ready';
  const ready = status === 'ready';
  if (ready && e.links.length === 0) {
    e.links = makeLinks(e.id, iso(e.readyAt), e.manifestOnly ? ['package'] : ['package', 'files']);
  }
  if (ready && e.filesState === 'pending') e.filesState = 'available';
  const myLink = (kind: ArchiveLinkKind): StoredLink | undefined => e.links.find((l) => l.kind === kind && l.party_role === ME_ROLE && l.revoked_at === null);
  const pkgLink = myLink('package');
  const filesLink = myLink('files');
  return {
    id: e.id,
    export_id: e.id,
    contract_id: e.contractId,
    status,
    progress: status === 'queued' ? 0 : status === 'running' ? 50 : 100,
    trigger: e.trigger,
    is_snapshot: e.isSnapshot,
    snapshot_at: e.snapshotAt,
    include_originals: e.includeOriginals,
    manifest_only: e.manifestOnly,
    evidence_count: e.evidenceCount,
    package: ready
      ? { url: pkgLink ? linkUrl(pkgLink.token) : null, size_bytes: e.packageSize, sha256: fakeSha(`${e.id}-package`), state: 'available', expires_at: null, shredded_at: null }
      : null,
    zip:
      ready && e.filesState !== 'not_requested'
        ? {
            url: filesLink && e.filesState === 'available' ? linkUrl(filesLink.token) : null,
            size_bytes: e.filesSize,
            sha256: fakeSha(`${e.id}-files`),
            state: e.filesState,
            expires_at: e.filesExpiresAt,
            shredded_at: e.filesShreddedAt,
          }
        : null,
    pdf: null,
    expires_at: e.filesExpiresAt,
    links: e.links.map(linkView),
    error: status === 'failed' ? 'Сборка прервана: хранилище недоступно.' : '',
    created_at: iso(e.createdAt),
    finished_at: status === 'ready' || status === 'failed' ? iso(e.readyAt) : null,
  };
}

export function getArchivePreview(contractId: string): ArchivePreview {
  const p = findPreview(contractId);
  const exports = exportsStore
    .filter((e) => e.contractId === contractId)
    .sort((a, b) => b.createdAt - a.createdAt)
    .map(toJob);
  return { ...p, exports };
}

export function startExport(contractId: string, options: ExportOptionsInput): ExportAccepted {
  const preview = findPreview(contractId);
  if (!preview.can_export) {
    throw new MockError(409, 'archive_nothing_to_export', 'Пока нечего собирать: договор ни разу не заморожен.');
  }
  if (options.include_originals && options.manifest_only) {
    throw new MockError(422, 'archive_options_conflict', '«Полный пакет» и «только манифест» несовместимы: выберите одно.');
  }
  // Идущая сборка с теми же опциями — тот же export (ADR-139 §4).
  const active = exportsStore.find((e) => {
    const j = toJob(e);
    return e.contractId === contractId && (j.status === 'queued' || j.status === 'running') && e.includeOriginals === options.include_originals && e.manifestOnly === options.manifest_only;
  });
  if (active) return { export_id: active.id, jobId: active.id, status: toJob(active).status };

  const id = nextId('exp');
  const createdAt = Date.now();
  const evidenceCount = preview.sections.find((s) => s.key === 'evidence')?.count ?? 0;
  const retention = preview.retention;
  exportsStore.push({
    id,
    contractId,
    createdAt,
    readyAt: createdAt + EXPORT_DELAY_MS,
    willFail: preview.contract_id === 'c-9305',
    trigger: 'manual',
    isSnapshot: preview.is_snapshot,
    snapshotAt: iso(createdAt),
    includeOriginals: options.include_originals,
    manifestOnly: options.manifest_only,
    evidenceCount,
    packageSize: 40_000 + evidenceCount * 4_800,
    filesSize: options.manifest_only ? 0 : options.include_originals ? preview.est_size_bytes || 900_000 : Math.round((preview.est_size_bytes || 900_000) * 0.06),
    filesState: options.manifest_only ? 'not_requested' : 'pending',
    filesShreddedAt: null,
    filesExpiresAt: retention.archive_until,
    links: [],
  });
  return { export_id: id, jobId: id, status: 'queued' };
}

export function getExportJob(contractId: string, exportId: string): ExportJob {
  const e = exportsStore.find((x) => x.id === exportId && x.contractId === contractId);
  if (!e) throw new MockError(404, 'not_found', 'Экспорт не найден.');
  return toJob(e);
}

export function revokeLink(linkId: string): ArchiveLink {
  for (const e of exportsStore) {
    const link = e.links.find((l) => l.id === linkId);
    if (link) {
      if (link.revoked_at === null) link.revoked_at = iso(Date.now());
      return linkView(link);
    }
  }
  throw new MockError(404, 'not_found', 'Ссылка не найдена.');
}
