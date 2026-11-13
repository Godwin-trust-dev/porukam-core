/**
 * Сборка `form_data` услуги под реальную схему бэка
 * (`backend/apps/contracts/forms.py`, SERVICE_SCHEMA, версия 1).
 *
 * Ключевое ограничение (ADR-088 Фаза 2): `PATCH form_data` — ПОЛНАЯ ЗАМЕНА
 * с полной валидацией (неизвестный ключ → 422 unknown_field, отсутствующее
 * обязательное видимое поле → 422 required; пустой объект валиден). Поэтому
 * шаги «Суть» и «Условия» всегда собирают и шлют форму ЦЕЛИКОМ, перенося
 * ключи «чужой» секции из последнего серверного `form_data`.
 */

import { ApiError } from '@porukam/core';

/**
 * Текст серверной ошибки формы для шагов мастера. 422 `form_data_invalid`
 * несёт полевые ошибки в `problem.context.errors` (П-16: «список ошибок по
 * полям в context, не строкой в detail») — раньше фронт показывал только
 * заголовок «form_data не соответствует схеме», и понять, какое поле
 * не прошло, было невозможно (отсмотр прода 2026-08-19).
 */
export function formDataErrorText(e: unknown): string | null {
  if (!(e instanceof ApiError)) return null;
  const ctx = e.problem.context as { errors?: { field?: string; message?: string }[] } | undefined;
  const messages = (ctx?.errors ?? []).map((x) => x.message).filter((m): m is string => !!m);
  return messages.length ? `${e.message}: ${messages.join('; ')}` : e.message;
}

/** Поля секций warranty/acceptance/modules — шаг «Условия». */
export const SERVICE_TERM_KEYS = [
  'warranty_period_days',
  'acceptance_window_hours',
  'subcontract_policy',
  'access_required',
  'portfolio_visible',
] as const;

export interface ServiceEssence {
  workDescription: string;
  locationType: 'onsite' | 'remote';
  locationAddress: string;
  termType: 'dates' | 'relative_to_gate';
  startDate: string;
  endDate: string;
  durationDays: string;
  priceType: 'fixed' | 'estimate';
}

export interface ServiceTerms {
  warrantyPeriodDays: string;
  acceptanceWindowHours: string;
  subcontractPolicy: 'forbidden' | 'allowed' | 'with_consent';
  accessRequired: boolean;
  portfolioVisible: boolean;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : v != null ? String(v) : '');

export function essenceFromFormData(fd: Record<string, unknown>): ServiceEssence {
  return {
    workDescription: str(fd.work_description),
    locationType: fd.location_type === 'remote' ? 'remote' : 'onsite',
    locationAddress: str(fd.location_address),
    termType: fd.term_type === 'relative_to_gate' ? 'relative_to_gate' : 'dates',
    startDate: str(fd.start_date),
    endDate: str(fd.end_date),
    durationDays: fd.duration_days != null ? String(fd.duration_days) : '',
    priceType: fd.price_type === 'estimate' ? 'estimate' : 'fixed',
  };
}

export function termsFromFormData(fd: Record<string, unknown>): ServiceTerms {
  return {
    warrantyPeriodDays: fd.warranty_period_days != null ? String(fd.warranty_period_days) : '14',
    acceptanceWindowHours: fd.acceptance_window_hours != null ? String(fd.acceptance_window_hours) : '72',
    subcontractPolicy:
      fd.subcontract_policy === 'allowed' || fd.subcontract_policy === 'with_consent'
        ? fd.subcontract_policy
        : 'forbidden',
    accessRequired: fd.access_required === true,
    portfolioVisible: fd.portfolio_visible !== false,
  };
}

/** Все обязательные видимые поля существа заполнены — форму можно отправлять на сервер. */
export function essenceComplete(sphereCode: string, e: ServiceEssence): boolean {
  if (!sphereCode || !e.workDescription.trim()) return false;
  if (e.locationType === 'onsite' && !e.locationAddress.trim()) return false;
  if (e.termType === 'dates') {
    if (!e.startDate || !e.endDate) return false;
  } else if (!e.durationDays || Number.isNaN(Number(e.durationDays))) {
    return false;
  }
  return true;
}

function essenceToFormData(sphereCode: string, e: ServiceEssence): Record<string, unknown> {
  return {
    sphere_code: sphereCode,
    work_description: e.workDescription.trim(),
    location_type: e.locationType,
    ...(e.locationType === 'onsite' ? { location_address: e.locationAddress.trim() } : {}),
    term_type: e.termType,
    ...(e.termType === 'dates'
      ? { start_date: e.startDate, end_date: e.endDate }
      : { duration_days: Number(e.durationDays) }),
    price_type: e.priceType,
  };
}

/** «Суть»: существо из формы + условия, перенесённые из серверного form_data (если уже были). */
export function buildEssenceFormData(
  sphereCode: string,
  e: ServiceEssence,
  prev: Record<string, unknown>,
): Record<string, unknown> {
  const carried: Record<string, unknown> = {};
  for (const key of SERVICE_TERM_KEYS) {
    if (prev[key] !== undefined) carried[key] = prev[key];
  }
  return { ...essenceToFormData(sphereCode, e), ...carried };
}

/** «Условия»: существо из серверного form_data + условия из формы. */
export function buildTermsFormData(
  prev: Record<string, unknown>,
  terms: ServiceTerms,
): Record<string, unknown> {
  const sphereCode = str(prev.sphere_code);
  return {
    ...essenceToFormData(sphereCode, essenceFromFormData(prev)),
    warranty_period_days: Number(terms.warrantyPeriodDays) || 0,
    acceptance_window_hours: Number(terms.acceptanceWindowHours) || 1,
    subcontract_policy: terms.subcontractPolicy,
    access_required: terms.accessRequired,
    portfolio_visible: terms.portfolioVisible,
  };
}
