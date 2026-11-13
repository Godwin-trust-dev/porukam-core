/**
 * Что именно допсоглашение умеет изменить в подписанном договоре — и как
 * пункт списка «Что меняем» превращается в `AmendmentChange` (ADR-161 §5).
 *
 * Словарь пунктов НЕ заводится заново: берётся тот же
 * `useRevisionItemOptions` (ADR-123/157), на котором стоит «Предложить
 * правку». Иначе два экрана показывали бы разные списки того, что в договоре
 * вообще можно изменить, и разошлись бы при первой же правке словаря.
 *
 * Но применимо допником НЕ всё: `apply_amendment_milestone_modify` /
 * `apply_amendment_material_modify` (backend/apps/milestones/services.py)
 * знают конечный набор ключей `payload`. Поэтому список фильтруется, а не
 * показывается целиком с молчаливым «ничего не произошло» на подписи:
 *
 * | пункт списка | change | payload |
 * |---|---|---|
 * | `milestone.<id>.title` | `modify_milestone` | `{title}` |
 * | `milestone.<id>.amount` | `modify_milestone` | `{amount, currency}` |
 * | `milestone.<id>.deadline` | `modify_milestone` | `{deadline}` |
 * | `material.<id>.quantity` | `modify_material` | `{quantity}` |
 * | `material.<id>.delivery_days` | `modify_material` | `{delivery_days}` |
 *
 * Не попали и почему: `payment.*`, `title`, `form.*` — у допника нет типа
 * изменения под поля самого договора (`AmendmentChange.Type` — этапы,
 * материалы и текстовое условие); `milestone.<id>.start_gate` — бэк не
 * применяет `depends_on` из допника; `material.<id>.type` —
 * `apply_amendment_material_modify` не трогает `catalog_item`. Текстовые
 * условия допника живут не в `changes`, а в его поле `custom_terms` — оно
 * отдельным полем формы.
 */
import { useMemo } from 'react';
import type { RealAmendmentChangeInput, RealContract } from '@porukam/core';
import { coerceRevisionValueForOption, useRevisionItemOptions, type RevisionItemOption } from './contractFields';

/** Поля структурных адресов ADR-157, которые допник реально применяет. */
const AMENDABLE_FIELDS: Record<string, readonly string[]> = {
  milestone: ['title', 'amount', 'deadline'],
  material: ['quantity', 'delivery_days'],
};

/** Ключ `payload`, под которым уходит значение пункта. Для суммы — пара
 * `{amount, currency}` (CLAUDE.md: деньги всегда парой), поэтому у неё
 * отдельная ветка в `amendmentChangeForOption`. */
const PAYLOAD_KEY: Record<string, string> = {
  title: 'title',
  deadline: 'deadline',
  quantity: 'quantity',
  delivery_days: 'delivery_days',
};

/** Разбор `<сущность>.<uuid>.<поле>` — зеркало `parse_structured_ref` бэка. */
function parseRef(ref: string): { kind: string; id: string; field: string } | null {
  const [kind, id, field] = ref.split('.');
  if (!kind || !id || !field) return null;
  return { kind, id, field };
}

/** Пункт списка применим допником? */
export function isAmendableRef(ref: string): boolean {
  const parsed = parseRef(ref);
  if (!parsed) return false;
  return (AMENDABLE_FIELDS[parsed.kind] ?? []).includes(parsed.field);
}

/**
 * Пункты «Что меняем» для формы допника — тот же словарь, отфильтрованный по
 * применимости. Порядок сохраняется (этапы, потом материалы), секции у
 * пунктов уже проставлены.
 */
export function useAmendmentChangeOptions(contract: RealContract): RevisionItemOption[] {
  const options = useRevisionItemOptions(contract);
  return useMemo(() => options.filter((o) => isAmendableRef(o.ref)), [options]);
}

/**
 * Пункт + введённое значение -> `AmendmentChange` для API. `null` — значение
 * пустое или пункт неприменим (форма такую строку не отправляет).
 *
 * Приведение типа значения — общее с протоколом разногласий
 * (`coerceRevisionValueForOption`): суммы уходят парой `{amount, currency}`,
 * даты — ISO-строкой, количество — десятичной строкой. Разница только в
 * упаковке: правка шлёт `new_value`, допник — `payload` с именованным ключом.
 */
export function amendmentChangeForOption(
  option: RevisionItemOption,
  raw: string,
): RealAmendmentChangeInput | null {
  const parsed = parseRef(option.ref);
  if (!parsed || !isAmendableRef(option.ref)) return null;
  if (raw.trim().length === 0) return null;

  const type = parsed.kind === 'milestone' ? 'modify_milestone' : 'modify_material';
  const value = coerceRevisionValueForOption(option, raw);

  // Сумма этапа: `coerceRevisionValueForOption` уже вернул пару
  // `{amount, currency}` — раскладываем её в ключи payload, которые знает
  // `apply_amendment_milestone_modify`.
  if (parsed.field === 'amount') {
    const money = value as { amount: string; currency: string };
    if (!money?.currency) return null;
    return { type, target: parsed.id, payload: { amount: money.amount, currency: money.currency } };
  }

  const key = PAYLOAD_KEY[parsed.field];
  if (!key) return null;
  return { type, target: parsed.id, payload: { [key]: value } };
}

/** Строка формы допника: пункт словаря + сырое значение поля «Стало». */
export interface AmendmentChangeRow {
  /** Стабильный ключ строки для React (пункт можно менять, ключ — нет). */
  key: string;
  ref: string;
  value: string;
}

/** Сырое значение из `payload` в строку для поля «Стало» — обратная сторона
 * `amendmentChangeForOption`. */
function rawValueOf(field: string, payload: Record<string, unknown>): string {
  const value = field === 'amount' ? payload.amount : payload[PAYLOAD_KEY[field] ?? ''];
  return value === undefined || value === null ? '' : String(value);
}

/**
 * Разбор существующего допника на строки формы + «остальное».
 *
 * PATCH заменяет `changes` ЦЕЛИКОМ (ADR-161 §2), поэтому изменения, которых
 * форма не умеет показывать (`add_milestone`, `custom_term`, скидка по спору
 * с `anti_waiver` в payload — ADR-131 §3), нельзя просто потерять при
 * сохранении: они уходят обратно как есть, в `passthrough`. Форма правит
 * только то, что показывает.
 */
export function splitAmendmentChanges(
  changes: { type: string; target: string | null; payload: Record<string, unknown> }[],
): { rows: AmendmentChangeRow[]; passthrough: RealAmendmentChangeInput[] } {
  const rows: AmendmentChangeRow[] = [];
  const passthrough: RealAmendmentChangeInput[] = [];

  changes.forEach((change, i) => {
    const kind = change.type === 'modify_milestone' ? 'milestone' : change.type === 'modify_material' ? 'material' : null;
    const fields = kind ? AMENDABLE_FIELDS[kind] ?? [] : [];
    // Одно изменение может нести несколько ключей payload (сумма + срок);
    // форма показывает их отдельными строками — при сохранении они снова
    // станут отдельными изменениями того же типа, результат для дерева тот же.
    const matched = kind && change.target ? fields.filter((f) => rawValueOf(f, change.payload) !== '') : [];
    // Ключи payload, за которые форма отвечает. Всё, что сверх них
    // (`anti_waiver` скидки по спору — ADR-131 §3, `sphere_code`), означает,
    // что изменение не наше: показать его форма не умеет, а «отредактировать
    // половину» хуже, чем не трогать вовсе.
    const known = new Set(matched.flatMap((f) => (f === 'amount' ? ['amount', 'currency'] : [PAYLOAD_KEY[f] ?? f])));
    const hasForeignKeys = Object.keys(change.payload).some((k) => !known.has(k));
    if (!kind || !change.target || matched.length === 0 || hasForeignKeys) {
      passthrough.push({ type: change.type as RealAmendmentChangeInput['type'], target: change.target, payload: change.payload });
      return;
    }
    for (const field of matched) {
      rows.push({ key: `${i}-${field}`, ref: `${kind}.${change.target}.${field}`, value: rawValueOf(field, change.payload) });
    }
  });

  return { rows, passthrough };
}
