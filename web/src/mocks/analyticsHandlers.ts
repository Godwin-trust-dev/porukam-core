import { http, HttpResponse } from 'msw';

const BASE = '/v1';

/** Принятые события шагов конструктора — для ассертов в тестах (ADR-145). */
export const recordedConstructorSteps: Array<{
  step_code: string;
  action: string;
  contract_id?: string;
}> = [];

export function resetRecordedConstructorSteps(): void {
  recordedConstructorSteps.length = 0;
}

/** Принятые события установки приложения — для ассертов в тестах (ADR-171). */
export const recordedInstallEvents: Array<{
  kind: string;
  platform?: string;
  display_mode?: string;
  source?: string;
}> = [];

export function resetRecordedInstallEvents(): void {
  recordedInstallEvents.length = 0;
}

const INSTALL_KINDS = [
  'install_prompt_shown',
  'install_click',
  'pwa_installed',
  'play_click',
  'standalone_open',
];

/**
 * Моки ДВУХ вводов аналитики — шагов конструктора и воронки установки. Нужны
 * и в мок-режиме: без них мастер договора и баннер установки сыпали бы в
 * консоль 404, а поведенческий слой не имеет права быть заметным.
 */
export const analyticsHandlers = [
  http.post(`${BASE}/analytics/constructor-step`, async ({ request }) => {
    const body = (await request.json().catch(() => ({}))) as {
      step_code?: string;
      action?: string;
      contract_id?: string;
    };
    if (!body.step_code || !body.action) {
      return new HttpResponse(null, { status: 400 });
    }
    recordedConstructorSteps.push({
      step_code: body.step_code,
      action: body.action,
      ...(body.contract_id ? { contract_id: body.contract_id } : {}),
    });
    return new HttpResponse(null, { status: 204 });
  }),

  // Ввод открыт анонимно (ADR-171): приложение ставят до регистрации, и
  // требование логина отсекло бы ровно тот случай, ради которого он заведён.
  http.post(`${BASE}/analytics/install-event`, async ({ request }) => {
    const body = (await request.json().catch(() => ({}))) as {
      kind?: string;
      platform?: string;
      display_mode?: string;
      source?: string;
    };
    if (!body.kind || !INSTALL_KINDS.includes(body.kind)) {
      return new HttpResponse(null, { status: 400 });
    }
    recordedInstallEvents.push({
      kind: body.kind,
      ...(body.platform ? { platform: body.platform } : {}),
      ...(body.display_mode ? { display_mode: body.display_mode } : {}),
      ...(body.source ? { source: body.source } : {}),
    });
    return new HttpResponse(null, { status: 204 });
  }),
];
