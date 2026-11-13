/**
 * «Материалы изменены контрагентом» — признак внимания на карточке договора
 * (фронтовой хвост ADR-156 + ADR-157 §5).
 *
 * ИСТОЧНИК ФАКТА — ХРОНИКА ДОГОВОРА, а не лента уведомлений. Причины:
 *
 * 1. ADR-157 §5 завёл `milestone.material_added/updated/removed` в
 *    `apps.contracts.events.NESTED_TOPICS` — три события уже приходят в
 *    `GET /contracts/{id}/timeline`, который карточка и так грузит
 *    (`useRealContractView`). Ни одного лишнего запроса.
 * 2. У события есть и актор (`actor.user_id`), и время (`occurred_at`), и
 *    этап (`subject.id`) — ровно то, что нужно бейджу.
 * 3. Уведомление приходит с ДЕБАУНСОМ до 10 минут (ADR-156) и не приходит
 *    вовсе в `draft`, а хроника — сразу и с актором. (Код шаблона в пункте
 *    ленты с ADR-159 есть — `template_code`; отличить повод по ленте теперь
 *    можно, но она всё равно опаздывает и не называет актора.)
 *
 * ОТМЕТКА «ПРОСМОТРЕНО» — СЕРВЕРНАЯ (ADR-158): `contract.materials_seen_at`
 * в карточке договора + `POST /contracts/{id}/materials-seen`. Локальная
 * отметка осталась ОПТИМИСТИЧНЫМ КЭШЕМ: она гасит оба бейджа (в «Обзоре» и
 * на этапе) мгновенно, не дожидаясь ответа, и держит мок-контур. Источник
 * правды — сервер, эффективная отметка — максимум из двух (`maxSeenAt`).
 */
import type { ContractRole, RealTimelineEvent } from '@porukam/core';

/** Топики правок материалов (ADR-155 публикует их из `apps.milestones`). */
const MATERIAL_TOPICS: ReadonlySet<string> = new Set([
  'milestone.material_added',
  'milestone.material_updated',
  'milestone.material_removed',
]);

export function isMaterialChangeEvent(e: RealTimelineEvent): boolean {
  return MATERIAL_TOPICS.has(e.kind ?? e.topic) || MATERIAL_TOPICS.has(e.topic);
}

/** Кто смотрит: реальный бэк кладёт в `actor` `user_id`, мок-контур — `role`.
 * Держим обе половины, чтобы признак работал на живом API и в тестах. */
export interface MaterialsChangeViewer {
  userId?: string | null;
  role?: ContractRole | null;
}

/** Последняя правка материалов ЧУЖОЙ стороной — время, этап и его название. */
export interface MaterialsChangeFact {
  at: string;
  milestoneId: string | null;
  milestoneTitle: string | null;
}

/** «Событие моё?» — `null`, когда по актору судить нельзя (пустой `actor`,
 * старый outbox). Неопределённость трактуем как «не бейджим»: ложный значок
 * внимания на карточке дороже пропущенного. */
function isOwnEvent(actor: unknown, viewer: MaterialsChangeViewer): boolean | null {
  const a = (actor ?? {}) as { user_id?: unknown; role?: unknown };
  if (typeof a.user_id === 'string' && a.user_id && viewer.userId) return a.user_id === viewer.userId;
  if (typeof a.role === 'string' && a.role && viewer.role) return a.role === viewer.role;
  return null;
}

/**
 * Самое свежее событие правки материалов, сделанное НЕ текущей стороной.
 * Порядок событий в ответе бэка — по `occurred_at`, но полагаться на него не
 * будем: берём максимум по времени.
 */
export function lastCounterpartyMaterialChange(
  events: readonly RealTimelineEvent[] | undefined,
  viewer: MaterialsChangeViewer,
): MaterialsChangeFact | null {
  let best: MaterialsChangeFact | null = null;
  for (const e of events ?? []) {
    if (!isMaterialChangeEvent(e)) continue;
    if (isOwnEvent(e.actor, viewer) !== false) continue;
    if (best && Date.parse(e.occurred_at) <= Date.parse(best.at)) continue;
    best = {
      at: e.occurred_at,
      milestoneId: e.subject?.type === 'milestone' ? (e.subject.id ?? null) : null,
      milestoneTitle: e.subject?.title ?? null,
    };
  }
  return best;
}

/* ── Отметка «материалы просмотрены» ──────────────────────────────────────
   Сервер хранит её на СТОРОНЕ договора (ADR-158, `ContractParty.
   materials_seen_at`), поэтому она переживает смену устройства и одинакова
   у двух представителей одного юрлица. Локальный слой ниже — оптимистичный
   кэш на устройство и профиль: он нужен ровно для мгновенного гашения обоих
   бейджей до ответа сервера. */

const SEEN_PREFIX = 'porukam.materials-seen';

/** Отметку ставит любая из двух точек входа (бейдж в «Обзоре» и бейдж в блоке
 * материалов), а видеть её обязаны обе — иначе один бейдж гаснет, а второй
 * висит. Подписка на изменение — вместо общего стора: факт один и булев. */
type SeenListener = () => void;
const seenListeners = new Set<SeenListener>();

export function subscribeMaterialsSeen(listener: SeenListener): () => void {
  seenListeners.add(listener);
  return () => {
    seenListeners.delete(listener);
  };
}

function seenKey(contractId: string, viewerKey: string | null | undefined): string {
  return `${SEEN_PREFIX}.${contractId}.${viewerKey ?? 'anon'}`;
}

export function readMaterialsSeenAt(contractId: string, viewerKey: string | null | undefined): string | null {
  try {
    return localStorage.getItem(seenKey(contractId, viewerKey));
  } catch {
    // Приватный режим/запрет хранилища — бейдж просто не «залипает»
    // просмотренным, но карточка не падает.
    return null;
  }
}

export function markMaterialsSeen(contractId: string, viewerKey: string | null | undefined, at: string): void {
  try {
    localStorage.setItem(seenKey(contractId, viewerKey), at);
  } catch {
    /* см. выше */
  }
  for (const listener of [...seenListeners]) listener();
}

/** Эффективная отметка — ПОЗДНЯЯ из серверной и локального кэша. Сервер
 * авторитетен, но отвечает не мгновенно, а кэш может отстать (отметку
 * поставили с другого устройства); максимум даёт верный ответ в обоих
 * случаях. Нечитаемое значение (битая строка) игнорируется. */
export function maxSeenAt(serverSeenAt: string | null, localSeenAt: string | null): string | null {
  const server = serverSeenAt ? Date.parse(serverSeenAt) : NaN;
  const local = localSeenAt ? Date.parse(localSeenAt) : NaN;
  if (Number.isNaN(server)) return Number.isNaN(local) ? null : localSeenAt;
  if (Number.isNaN(local)) return serverSeenAt;
  return server >= local ? serverSeenAt : localSeenAt;
}

/** Показывать ли бейдж: есть чужая правка позже отметки просмотра. */
export function hasUnseenMaterialsChange(fact: MaterialsChangeFact | null, seenAt: string | null): boolean {
  if (!fact) return false;
  if (!seenAt) return true;
  const seen = Date.parse(seenAt);
  return Number.isNaN(seen) || Date.parse(fact.at) > seen;
}
