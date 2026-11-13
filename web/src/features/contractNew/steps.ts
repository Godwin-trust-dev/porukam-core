import type { ClientOption } from './draftStore';

export interface WizardStepDef {
  key: string;
  path: string;
}

/**
 * ADR-088 Фаза 2 — число шагов stepper адаптивно. «Сфера» — только услуга
 * (sphere_code — обязательное поле её form_data-схемы). «Этапы/Условия» —
 * только услуга: условия (гарантия/приёмка/модули) — секции её схемы, а у
 * Продажи единственный этап «передача товара», валюту и способ оплаты
 * собирает шаг «Суть». У Аренды/Займа формы существа ещё не подключены
 * (см. formConnected/PreviewStepPage — отправка для них заблокирована).
 */
export function stepsFor(option: ClientOption | null): WizardStepDef[] {
  const steps: WizardStepDef[] = [{ key: 'type', path: 'type' }];
  if (option === 'service') steps.push({ key: 'sphere', path: 'sphere' });
  steps.push({ key: 'parties', path: 'parties' }, { key: 'details', path: 'details' });
  if (option === 'service') {
    steps.push({ key: 'stages', path: 'stages' }, { key: 'terms', path: 'terms' });
  }
  steps.push({ key: 'preview', path: 'preview' });
  return steps;
}

/** Подключена ли форма существа для выбранной опции (ADR-088 Фаза 2 — услуга;
 * продажа — отсмотр 2026-08-20, saleFormData.ts). Аренда/Займ — ещё нет. */
/** Все четыре опции дерева имеют форму существа (Аренда/Займ — по схеме
 * бэка, ADR-105); `null` — тип ещё не выбран. */
export function isFormConnected(option: ClientOption | null): boolean {
  return option !== null;
}
