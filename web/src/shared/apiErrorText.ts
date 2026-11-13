import { ApiError } from '@porukam/core';

/**
 * Человекочитаемый текст ошибки для `ErrorState.text` (ADR-119): `problem.title`
 * приходит с бэка на языке запроса (`Accept-Language` → `resolve_request_locale`,
 * ADR-075/077/119). Старые бэки для стандартных DRF-ошибок отдавали
 * `title == code` — такой «текст» не показываем (код и так печатается ниже).
 */
export function apiErrorText(err: unknown): string | undefined {
  if (!(err instanceof ApiError)) return undefined;
  const title = err.problem.title?.trim();
  if (!title || title === err.code) return undefined;
  return title;
}
