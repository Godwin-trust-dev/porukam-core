/**
 * Проекция списка сделок (DEV-13) — читает реальные записи `contractsDb` (мок-FSM, Ф2) и
 * достраивает недостающие для витрины статусы (completed/warranty/terminated/suspended…,
 * которых пока нет среди живых seed-договоров) синтетическими строками. Отдельная от
 * `ContractDetail` проекция — как `dbSummaries()` раньше для Ф1 `DealsPage`, но с единым
 * статусом (`computeCardStatus`, ADR-010) и полями под вкладки/фильтры/поиск (§2/§3).
 */
import type {
  ContractCardStatus,
  ContractDetail,
  ContractListItem,
  ContractRole,
  ContractsListCounts,
  ContractsListQuery,
  ContractsListResult,
  ContractsListSort,
  ContractsListTab,
  ContractStatus,
  ContractSummary,
  DashboardPaymentMethod,
} from '@porukam/core';
import { computeCardStatus } from '@porukam/core';
import { db, ME_BIZ, ME_PERSON } from './contractsDb';
import { mockContracts } from './data';

const MY_HANDLES = new Set([ME_PERSON.handle, ME_BIZ.handle]);

/** Ф1-витрина (`mockContracts`, старый плоский `ContractStatus`) → единый статус (ADR-010). */
const OLD_STATUS_MAP: Record<ContractStatus, ContractCardStatus> = {
  draft: 'draft',
  under_negotiation: 'under_review',
  pending_signature: 'pending_signature',
  active: 'in_progress',
  under_acceptance: 'in_progress',
  completed: 'completed',
  disputed: 'in_progress',
  terminated: 'terminated_by_customer',
};

function buildLegacyItem(c: ContractSummary): ContractListItem | null {
  const mine = c.parties.find((p) => p.handle === ME_PERSON.handle || p.handle === ME_BIZ.handle);
  const myRole = mine?.role ?? c.my_role;
  const other = c.parties.find((p) => p.role !== myRole);
  return {
    id: c.id,
    no: c.id,
    title: c.title,
    sphere: { key: c.sphere, label: c.sphere },
    counterparty: other ? { name: other.display_name, handle: other.handle } : { name: '—', handle: '' },
    viewer_role: myRole,
    status: OLD_STATUS_MAP[c.status],
    amount: c.total,
    pay_method: c.payment_protected ? 'sbp' : 'bank',
    progress:
      c.status === 'active' || c.status === 'under_acceptance'
        ? { done: c.milestones_accepted, total: c.milestones_total }
        : undefined,
    updated_at: c.updated_at,
  };
}

const shortDate = (iso: string) => new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short' }).format(new Date(iso));

function myRoleOf(c: ContractDetail): ContractRole | null {
  return c.parties.find((p) => MY_HANDLES.has(p.handle))?.role ?? null;
}

function counterpartyOf(c: ContractDetail, myRole: ContractRole): { name: string; handle: string } {
  const other = c.parties.find((p) => p.role !== myRole);
  return other ? { name: other.display_name, handle: other.handle } : { name: '—', handle: '' };
}

function statusOf(c: ContractDetail): ContractCardStatus {
  const hasSuspendedStage = c.milestones.some((m) => m.status === 'suspended');
  return computeCardStatus({ status: c.status, execution: c.execution, hasSuspendedStage });
}

function attentionOf(c: ContractDetail, myRole: ContractRole): { label: string } | undefined {
  const label = c.attention?.views[myRole]?.primary?.label;
  return label ? { label } : undefined;
}

function nextOf(c: ContractDetail, status: ContractCardStatus, myRole: ContractRole): { label: string } | undefined {
  switch (status) {
    case 'draft':
      return undefined;
    case 'under_review': {
      const open = c.revisions.find((r) => r.status === 'open');
      if (!open) return { label: 'На согласовании' };
      return { label: open.author_role === myRole ? 'Ваш ход' : 'Ход контрагента' };
    }
    case 'pending_signature':
      return { label: 'Версия заморожена' };
    case 'awaiting_signatures':
      return { label: 'Ждём подписи' };
    case 'signed':
      return { label: 'Готов к работе' };
    case 'in_progress': {
      const activeLeaf = c.milestones.find((m) => m.kind === 'leaf' && (m.status === 'in_progress' || m.status === 'suspended'));
      return { label: activeLeaf?.meta ?? 'В работе' };
    }
    case 'suspended': {
      const susp = c.milestones.find((m) => m.status === 'suspended');
      return { label: susp?.meta ?? 'Приостановлен' };
    }
    case 'completed':
      return { label: `Закрыт ${shortDate(c.updated_at)}` };
    case 'under_warranty':
    case 'warranty_claim':
      return { label: 'На гарантии' };
    case 'terminated_by_customer':
    case 'terminated_by_contractor':
      return { label: `Расторгнут ${shortDate(c.updated_at)}` };
    case 'rejected_by_counterparty':
    case 'withdrawn_by_initiator':
      return { label: `Не заключён ${shortDate(c.updated_at)}` };
    default:
      return undefined;
  }
}

function progressOf(c: ContractDetail, status: ContractCardStatus): { done: number; total: number } | undefined {
  if (status !== 'in_progress' && status !== 'suspended') return undefined;
  const leaves = c.milestones.filter((m) => m.kind === 'leaf');
  if (leaves.length === 0) return undefined;
  const done = leaves.filter((m) => m.status === 'accepted' || m.status === 'paid').length;
  return { done, total: leaves.length };
}

/** Шаг мастера (ключи `contractNew.steps.*`, DEV-09) — эвристика по заполненности черновика. */
function draftStepOf(c: ContractDetail): string | undefined {
  if (c.status !== 'draft') return undefined;
  if (!c.sphere) return 'sphere';
  if (c.parties.length < 2) return 'parties';
  if (!c.title) return 'details';
  if (!c.milestones.some((m) => m.kind === 'leaf')) return 'stages';
  return 'preview';
}

function buildItem(c: ContractDetail): ContractListItem | null {
  const myRole = myRoleOf(c);
  if (!myRole) return null;
  const status = statusOf(c);
  return {
    id: c.id,
    no: c.no ?? c.id,
    title: c.title || '(черновик без названия)',
    sphere: { key: c.sphere || 'other', label: c.sphere || 'Без сферы' },
    counterparty: counterpartyOf(c, myRole),
    viewer_role: myRole,
    status,
    needs_attention: attentionOf(c, myRole),
    amount: c.total,
    pay_method: c.payment_method ?? 'cash',
    next: nextOf(c, status, myRole),
    progress: progressOf(c, status),
    updated_at: c.updated_at,
    draft_step: draftStepOf(c),
  };
}

const iso = (daysAgo: number) => new Date(Date.now() - daysAgo * 86_400_000).toISOString();
const RUB = (a: string) => ({ amount: a, currency: 'RUB' });

/**
 * Синтетические строки (DEV-13 §5/§7) — статусы, которых пока нет среди живых seed-договоров
 * `contractsDb` (pending_signature/completed/warranty/terminated/suspended). Не самостоятельные
 * `ContractDetail` — только проекция для витрины списка.
 */
function syntheticItems(): ContractListItem[] {
  return [
    {
      id: 'c-7001',
      no: '№ 2026-0701',
      title: 'Электрика в новостройке',
      sphere: { key: 'electrical', label: 'Электрика' },
      counterparty: { name: 'Дмитрий Косяк', handle: '@d_kosyak' },
      viewer_role: 'contractor',
      status: 'pending_signature',
      amount: RUB('54000.00'),
      pay_method: 'sbp',
      next: { label: 'Версия заморожена' },
      updated_at: iso(1),
    },
    {
      id: 'c-7002',
      no: '№ 2026-0702',
      title: 'Сборка кухонного гарнитура',
      sphere: { key: 'furniture', label: 'Сборка мебели' },
      counterparty: { name: 'Анна Свет', handle: '@anna_svet' },
      viewer_role: 'contractor',
      status: 'suspended',
      amount: RUB('38000.00'),
      pay_method: 'cash',
      next: { label: 'Ждём материалы' },
      progress: { done: 1, total: 3 },
      updated_at: iso(2),
    },
    {
      id: 'c-7003',
      no: '№ 2026-0530',
      title: 'Ремонт ванной, 5 м²',
      sphere: { key: 'repair', label: 'Ремонт' },
      counterparty: { name: 'Мастер Ремонт', handle: '@masterremont' },
      viewer_role: 'customer',
      status: 'completed',
      amount: RUB('96000.00'),
      pay_method: 'bank',
      next: { label: `Закрыт ${shortDate(iso(14))}` },
      updated_at: iso(14),
    },
    {
      id: 'c-7004',
      no: '№ 2026-0410',
      title: 'Установка сантехники',
      sphere: { key: 'plumbing', label: 'Сантехника' },
      counterparty: { name: 'Николай Гром', handle: '@grom_master' },
      viewer_role: 'customer',
      status: 'under_warranty',
      amount: RUB('27000.00'),
      pay_method: 'sbp',
      next: { label: 'На гарантии' },
      updated_at: iso(60),
    },
    {
      id: 'c-7005',
      no: '№ 2026-0602',
      title: 'Отделка балкона',
      sphere: { key: 'finishing', label: 'Отделочные работы' },
      counterparty: { name: 'Игорь Волков', handle: '@i_volkov' },
      viewer_role: 'contractor',
      status: 'terminated_by_customer',
      amount: RUB('61000.00'),
      pay_method: 'cash',
      next: { label: `Расторгнут ${shortDate(iso(9))}` },
      updated_at: iso(9),
    },
  ];
}

function tabOf(status: ContractCardStatus): ContractsListTab {
  if (status === 'draft') return 'drafts';
  const archived: ContractCardStatus[] = [
    'completed',
    'under_warranty',
    'warranty_claim',
    'terminated_by_customer',
    'terminated_by_contractor',
    'rejected_by_counterparty',
    'withdrawn_by_initiator',
  ];
  return archived.includes(status) ? 'archive' : 'active';
}

/** «По дедлайну» — мок не хранит отдельную сырую дату дедлайна в проекции (только готовый
 * `next.label`), поэтому сортирует как «по обновлению»; реальный API — Э4. */
function sortItems(items: ContractListItem[], sort: ContractsListSort): ContractListItem[] {
  const arr = [...items];
  if (sort === 'amount') {
    arr.sort((a, b) => Number(b.amount.amount) - Number(a.amount.amount));
  } else {
    arr.sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime());
  }
  return arr;
}

export function listContracts(query: ContractsListQuery): ContractsListResult {
  const real = db
    .list()
    .map(buildItem)
    .filter((x): x is ContractListItem => x !== null);
  const legacy = mockContracts.map(buildLegacyItem).filter((x): x is ContractListItem => x !== null);
  const items = [...real, ...legacy, ...syntheticItems()];

  const counts: ContractsListCounts = { active: 0, archive: 0, drafts: 0, all: items.length };
  for (const it of items) counts[tabOf(it.status)] += 1;

  let filtered = query.tab === 'all' ? items : items.filter((it) => tabOf(it.status) === query.tab);
  if (query.role) filtered = filtered.filter((it) => it.viewer_role === query.role);
  if (query.status) filtered = filtered.filter((it) => it.status === query.status);
  if (query.sphere) filtered = filtered.filter((it) => it.sphere.key === query.sphere);
  if (query.pay) filtered = filtered.filter((it) => it.pay_method === (query.pay as DashboardPaymentMethod));
  if (query.q) {
    const q = query.q.trim().toLowerCase();
    filtered = filtered.filter(
      (it) => it.title.toLowerCase().includes(q) || it.counterparty.name.toLowerCase().includes(q) || it.no.toLowerCase().includes(q),
    );
  }

  return { items: sortItems(filtered, query.sort), counts };
}
