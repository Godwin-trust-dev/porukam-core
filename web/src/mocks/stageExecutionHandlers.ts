import { http, HttpResponse } from 'msw';
import type { StageEvidenceBind } from '@porukam/core';
import {
  connectStageDriveBackup,
  deleteStageEvidence,
  getStageDriveBackup,
  getStageExecution,
  getStageTimeline,
  submitStage,
  uploadStageEvidence,
} from './stageExecutionDb';
import { MockError } from './contractsDb';

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

/**
 * Сдача этапа + доказательства (DEV-11): доменный контур исполнителя — требует
 * X-Acting-Profile (гейт роли решает страница). Drive-бэкап — МОК-ТОЛЬКО (§11).
 */
export const stageExecutionHandlers = [
  http.get(`${BASE}/contracts/:id/stages/:sid`, ({ request, params }) =>
    auth(request) ?? run(() => getStageExecution(String(params.id), String(params.sid))),
  ),
  http.get(`${BASE}/contracts/:id/stages/:sid/timeline`, ({ request, params }) =>
    auth(request) ?? run(() => getStageTimeline(String(params.id), String(params.sid))),
  ),
  http.post(`${BASE}/contracts/:id/stages/:sid/evidence`, async ({ request, params }) => {
    const a = auth(request);
    if (a) return a;
    const body = (await request.json().catch(() => ({}))) as { filename?: string; mime?: string; size?: number; bind?: StageEvidenceBind };
    if (!body.filename || !body.bind) return problem(422, 'invalid_evidence_input', 'Нужен файл и привязка.');
    return run(() =>
      uploadStageEvidence(String(params.id), String(params.sid), {
        filename: body.filename!,
        mime: body.mime ?? 'application/octet-stream',
        size: body.size ?? 0,
        bind: body.bind!,
      }),
    );
  }),
  http.delete(`${BASE}/contracts/:id/stages/:sid/evidence/:eid`, ({ request, params }) =>
    auth(request) ??
    run(() => {
      deleteStageEvidence(String(params.id), String(params.sid), String(params.eid));
      return { deleted: true };
    }),
  ),
  http.post(`${BASE}/contracts/:id/stages/:sid/submit`, ({ request, params }) =>
    auth(request) ?? run(() => submitStage(String(params.id), String(params.sid))),
  ),
  http.get(`${BASE}/me/drive-backup`, ({ request }) => auth(request) ?? run(() => getStageDriveBackup())),
  http.post(`${BASE}/me/drive-backup`, ({ request }) => auth(request) ?? run(() => connectStageDriveBackup())),
];
