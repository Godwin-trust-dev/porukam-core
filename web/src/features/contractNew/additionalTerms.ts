/**
 * ADR-167 — «Дополнительные условия» мастера: произвольные пункты текста
 * договора, которые пишет сам инициатор. Пределы зеркалят бэк
 * (`apps.contracts.services.clean_additional_terms`): непустые после trim,
 * ≤ ADDITIONAL_TERM_MAX_LENGTH символов, ≤ ADDITIONAL_TERMS_MAX_ITEMS
 * пунктов — 400 `additional_terms_invalid` иначе. Конструктор держит и
 * пустые строки (только что нажали «Добавить условие»), на сервер уходит
 * очищенный список.
 */
export const ADDITIONAL_TERM_MAX_LENGTH = 2000;
export const ADDITIONAL_TERMS_MAX_ITEMS = 20;

/** Значение для PATCH: trim + выброс пустых пунктов (бэк их не принимает). */
export function cleanAdditionalTerms(items: string[]): string[] {
  return items.map((s) => s.trim()).filter((s) => s.length > 0);
}

/**
 * Список для конструктора из значения договора. Пустой массив — не «одно
 * пустое поле»: блок начинается с кнопки «Добавить условие», как этапы.
 */
export function additionalTermsFromContract(value: string[] | undefined): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}
