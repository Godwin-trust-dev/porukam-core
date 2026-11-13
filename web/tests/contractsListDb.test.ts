import { describe, it, expect, beforeEach } from 'vitest';
import { db, resetContracts, resetPayouts } from '../src/mocks/contractsDb';
import { listContracts } from '../src/mocks/contractsListDb';

beforeEach(() => {
  resetContracts();
  resetPayouts();
});

describe('contractsListDb (DEV-13) — проекция списка сделок', () => {
  it('⭐ без фильтров (кроме вкладки) возвращает и заказчика, и исполнителя — симметрия/микс ролей', () => {
    const { items } = listContracts({ tab: 'all', sort: 'updated' });
    const roles = new Set(items.map((i) => i.viewer_role));
    expect(roles.has('customer')).toBe(true);
    expect(roles.has('contractor')).toBe(true);
  });

  it('вкладка «active» не включает draft/archive-статусы', () => {
    const { items } = listContracts({ tab: 'active', sort: 'updated' });
    expect(items.every((i) => i.status !== 'draft')).toBe(true);
    expect(items.every((i) => !['completed', 'under_warranty', 'warranty_claim', 'terminated_by_customer', 'terminated_by_contractor', 'rejected_by_counterparty', 'withdrawn_by_initiator'].includes(i.status))).toBe(true);
  });

  it('вкладка «drafts» — только draft', () => {
    const { items } = listContracts({ tab: 'drafts', sort: 'updated' });
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((i) => i.status === 'draft')).toBe(true);
  });

  it('вкладка «archive» включает и завершённые, и терминальные/не состоявшиеся', () => {
    const { items } = listContracts({ tab: 'archive', sort: 'updated' });
    const statuses = new Set(items.map((i) => i.status));
    expect(statuses.has('completed') || statuses.has('under_warranty')).toBe(true);
    expect(statuses.has('terminated_by_customer') || statuses.has('rejected_by_counterparty') || statuses.has('withdrawn_by_initiator')).toBe(true);
  });

  it('счётчики (`counts`) не зависят от текущей вкладки/фильтров', () => {
    const a = listContracts({ tab: 'active', sort: 'updated' });
    const b = listContracts({ tab: 'drafts', sort: 'updated', q: 'ничего-не-найдено-12345' });
    expect(a.counts).toEqual(b.counts);
    expect(a.counts.active + a.counts.archive + a.counts.drafts).toBeLessThanOrEqual(a.counts.all);
  });

  it('фильтр по роли сужает список', () => {
    const all = listContracts({ tab: 'all', sort: 'updated' });
    const customersOnly = listContracts({ tab: 'all', role: 'customer', sort: 'updated' });
    expect(customersOnly.items.length).toBeLessThan(all.items.length);
    expect(customersOnly.items.every((i) => i.viewer_role === 'customer')).toBe(true);
  });

  it('поиск без совпадений → пусто', () => {
    const { items } = listContracts({ tab: 'all', sort: 'updated', q: 'zzz-нет-такого-договора-zzz' });
    expect(items).toHaveLength(0);
  });

  it('поиск по названию находит договор', () => {
    const { items } = listContracts({ tab: 'all', sort: 'updated', q: 'кухни' });
    expect(items.some((i) => i.title.toLowerCase().includes('кухни'))).toBe(true);
  });

  it('сортировка по сумме — убывание', () => {
    const { items } = listContracts({ tab: 'all', sort: 'amount' });
    const amounts = items.map((i) => Number(i.amount.amount));
    expect(amounts).toEqual([...amounts].sort((x, y) => y - x));
  });
});

describe('db.deleteDraft (DEV-13 §5/§7) — только черновик', () => {
  it('удаляет черновик', () => {
    const draft = db.list().find((c) => c.status === 'draft')!;
    db.deleteDraft(draft.id);
    expect(db.list().find((c) => c.id === draft.id)).toBeUndefined();
  });

  it('не позволяет удалить не-черновик', () => {
    const signed = db.list().find((c) => c.status !== 'draft')!;
    expect(() => db.deleteDraft(signed.id)).toThrow();
  });
});

describe('db.createDraft {source_contract_id} — ADR-050 «как в прошлый раз» (§6)', () => {
  it('клонирует сферу/этапы/условия источника, ничего не подписывает', () => {
    const source = db.list().find((c) => c.milestones.some((m) => m.kind === 'leaf'))!;
    const copy = db.createDraft({ my_role: 'contractor', acting_as: 'person', source_contract_id: source.id });
    expect(copy.status).toBe('draft');
    expect(copy.id).not.toBe(source.id);
    expect(copy.sphere).toBe(source.sphere);
    expect(copy.milestones.filter((m) => m.kind === 'leaf')).toHaveLength(source.milestones.filter((m) => m.kind === 'leaf').length);
    expect(copy.signatures).toHaveLength(0);
    // Свежие id этапов — не совпадают с источником (не одна и та же ссылка/запись).
    const sourceLeafIds = new Set(source.milestones.filter((m) => m.kind === 'leaf').map((m) => m.id));
    expect(copy.milestones.filter((m) => m.kind === 'leaf').every((m) => !sourceLeafIds.has(m.id))).toBe(true);
  });
});
