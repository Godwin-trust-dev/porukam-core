/**
 * Реестр доменных кодов ошибок (ТЗ §9.8, техспецификация §7.5).
 *
 * Бэкенд отвечает application/problem+json (RFC 9457) с доменным `code`.
 * В Ф6 этот реестр синхронизируется с enum из OpenAPI; сейчас — ручной срез
 * кодов, на которые UI обязан реагировать (ТЗ §9.8).
 */
export const DOMAIN_ERROR_CODES = [
  'verification_required',
  'contract_fee_charge_failed',
  'checklist_item_required',
  'contract_type_excluded',
  'entity_not_operable',
  'version_stale',
  'open_revisions',
  'leaf_sum_mismatch',
  'requisites_missing',
  /** DEV-10 §5 — «принять все» с финансово значимыми правками требует явного подтверждения раскладки. */
  'confirm_summary_required',
  'revision_closed',
  'not_initiator',
  'not_counterparty',
  /** ADR-161 — править и удалять можно только ЧЕРНОВИК допника; отправленный закрывают withdraw. */
  'amendment_not_draft',
  'variant_required',
  'milestone_already_accepted',
  'remark_item_required',
  'material_already_received',
  'fix_rounds_exhausted',
  'rate_limited',
  'not_found',
] as const;

export type DomainErrorCode = (typeof DOMAIN_ERROR_CODES)[number];

/** Ответ RFC 9457 (application/problem+json) с доменным расширением `code`. */
export interface ProblemDetails {
  type?: string;
  title?: string;
  status?: number;
  detail?: string;
  instance?: string;
  code?: string;
  /** Требуемый уровень верификации для verification_required. */
  required_level?: string;
  /** Секунды до повтора для 429. */
  retry_after?: number;
  [k: string]: unknown;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: DomainErrorCode | string | undefined;
  readonly problem: ProblemDetails;

  constructor(status: number, problem: ProblemDetails) {
    super(problem.detail || problem.title || `HTTP ${status}`);
    this.name = 'ApiError';
    this.status = status;
    this.problem = problem;
    this.code = normalizeCode(status, problem.code);
  }

  is(code: DomainErrorCode): boolean {
    return this.code === code;
  }
}

/** Приватность (404) трактуется как «нет объекта» — существование не раскрывается (ТЗ §2 п.6). */
function normalizeCode(status: number, code: string | undefined): string | undefined {
  if (code) return code;
  if (status === 404) return 'not_found';
  if (status === 429) return 'rate_limited';
  return undefined;
}

export type UiErrorAction =
  | { kind: 'start_esia'; requiredLevel?: string }
  | { kind: 'reload_resource' }
  | { kind: 'backoff'; retryAfter?: number }
  | { kind: 'inline_hint' }
  | { kind: 'treat_as_absent' }
  | { kind: 'generic' };

/**
 * Маппинг доменного кода на UX-реакцию (таблица ТЗ §9.8).
 * Тестируется в core/tests/errors.test.ts.
 */
export function mapErrorToAction(err: ApiError): UiErrorAction {
  switch (err.code) {
    case 'verification_required':
      return { kind: 'start_esia', requiredLevel: err.problem.required_level };
    case 'version_stale':
      return { kind: 'reload_resource' };
    case 'rate_limited':
      return { kind: 'backoff', retryAfter: err.problem.retry_after };
    case 'not_found':
      return { kind: 'treat_as_absent' };
    case 'checklist_item_required':
    case 'remark_item_required':
    case 'open_revisions':
    case 'leaf_sum_mismatch':
    case 'requisites_missing':
    case 'confirm_summary_required':
    case 'revision_closed':
    case 'not_initiator':
    case 'not_counterparty':
    case 'amendment_not_draft':
    case 'variant_required':
    case 'entity_not_operable':
    case 'contract_type_excluded':
    case 'contract_fee_charge_failed':
      return { kind: 'inline_hint' };
    default:
      return { kind: 'generic' };
  }
}
