import { http, HttpResponse } from 'msw';
import type { ContractsListQuery, ContractsListSort, ContractsListTab } from '@porukam/core';
import { db, MockError } from './contractsDb';
import { listContracts } from './contractsListDb';

const BASE = '/v1';

function problem(status: number, code: string, detail: string) {
  return new HttpResponse(JSON.stringify({ status, code, title: code, detail }), {
    status,
    headers: { 'Content-Type': 'application/problem+json' },
  });
}

function auth(request: Request): HttpResponse | null {
  if (!request.headers.get('Authorization')?.startsWith('Bearer ')) {
    return problem(401, 'unauthorized', 'Нужен вход.');
  }
  if (!request.headers.get('X-Acting-Profile')) {
    return problem(400, 'acting_profile_required', 'Не выбран профиль актёра.');
  }
  return null;
}

function run<T>(fn: () => T): HttpResponse {
  try {
    return HttpResponse.json(fn() as object);
  } catch (e) {
    if (e instanceof MockError) return problem(e.status, e.code, e.message);
    throw e;
  }
}

const TABS: ContractsListTab[] = ['active', 'archive', 'drafts', 'all'];
const SORTS: ContractsListSort[] = ['updated', 'amount', 'deadline'];

/**
 * Список сделок (DEV-13): GET заменяет старую курсорную витрину Ф1 (`DealsPage`) — без
 * ролевого ветвления (§4 «фильтры по умолчанию пусты», симметрия). DELETE — только draft
 * (§5/§7); зарегистрирован здесь, а не в `contractHandlers.ts`, чтобы не трогать общий файл
 * договорного контура лишний раз.
 */
export const contractsListHandlers = [
  http.get(`${BASE}/contracts`, ({ request }) => {
    const a = auth(request);
    if (a) return a;
    const url = new URL(request.url);
    const tabParam = url.searchParams.get('tab');
    const sortParam = url.searchParams.get('sort');
    const query: ContractsListQuery = {
      tab: TABS.includes(tabParam as ContractsListTab) ? (tabParam as ContractsListTab) : 'active',
      role: (url.searchParams.get('role') as ContractsListQuery['role']) || undefined,
      status: (url.searchParams.get('status') as ContractsListQuery['status']) || undefined,
      sphere: url.searchParams.get('sphere') || undefined,
      pay: (url.searchParams.get('pay') as ContractsListQuery['pay']) || undefined,
      q: url.searchParams.get('q') || undefined,
      sort: SORTS.includes(sortParam as ContractsListSort) ? (sortParam as ContractsListSort) : 'updated',
    };
    return run(() => listContracts(query));
  }),

  http.delete(`${BASE}/contracts/:id`, ({ request, params }) => auth(request) ?? run(() => db.deleteDraft(String(params.id)))),
];
