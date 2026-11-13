/**
 * Хеш ссылки → вкладка карточки договора (ADR-170).
 *
 * Уведомление обязано открывать РАЗДЕЛ, о котором оно пришло, а не «общую
 * вкладку сделки» (владелец 07.09: «потом допустим в правку надо искать»).
 * Бэк отдаёт цель якорем в `action.href` пункта ленты (та же строка уходит в
 * пуш и в кнопку письма) — здесь она разбирается ОДНОЙ таблицей, а не цепочкой
 * `if`: вкладок восемь, и каждая следующая ветка ломала бы порядок проверок.
 *
 * Правила устойчивости:
 * - неизвестный хеш игнорируется (`null`) — вкладку, на которой человек уже
 *   стоит, чужая ссылка не сбивает;
 * - вкладки, которой у ЭТОГО договора нет (чат без второй стороны, допники до
 *   подписания), не существует и в строке вкладок — такой якорь ведёт на обзор,
 *   то есть ровно туда, куда уведомление вело до этой ветки, а не на пустой
 *   экран;
 * - `#milestone-<id>` — якорь конкретного этапа (ADR-156 §3): вкладка «Этапы»,
 *   а прокруткой к самому этапу занимается браузер.
 */

export type ContractCardTab =
  | 'overview'
  | 'terms'
  | 'stages'
  | 'payments'
  | 'chat'
  | 'negoSign'
  | 'amendments'
  | 'timeline';

/** Какие условные вкладки есть у конкретного договора. */
export interface ContractTabsAvailability {
  /** `hasChat` карточки — переписка есть у договора с двумя сторонами. */
  chat: boolean;
  /** `amendmentsVisible` — допники только у подписанного (ADR-161 §1). */
  amendments: boolean;
}

const MILESTONE_HASH_PREFIX = '#milestone-';

const TAB_BY_HASH: Record<string, ContractCardTab> = {
  '#overview': 'overview',
  '#terms': 'terms',
  '#stages': 'stages',
  '#payments': 'payments',
  '#chat': 'chat',
  '#negoSign': 'negoSign',
  '#amendments': 'amendments',
  '#timeline': 'timeline',
};

export function contractTabFromHash(
  hash: string,
  available: ContractTabsAvailability,
): ContractCardTab | null {
  const tab = hash.startsWith(MILESTONE_HASH_PREFIX) ? 'stages' : TAB_BY_HASH[hash];
  if (!tab) return null;
  if (tab === 'chat' && !available.chat) return 'overview';
  if (tab === 'amendments' && !available.amendments) return 'overview';
  return tab;
}

/**
 * То же для мок-карточки (дизайн-режим, `c-*`-договоры): вкладок там меньше и
 * «Переговоры»/«Подпись» разведены на две. Свои ключи — своя таблица; сводить
 * их в одну значило бы делать вид, что экраны одинаковые.
 */
const LEGACY_TAB_BY_HASH: Record<string, string> = {
  '#overview': 'overview',
  '#stages': 'stages',
  '#negoSign': 'nego',
  '#timeline': 'timeline',
};

export function legacyContractTabFromHash(hash: string): string | null {
  if (hash.startsWith(MILESTONE_HASH_PREFIX)) return 'stages';
  return LEGACY_TAB_BY_HASH[hash] ?? null;
}
