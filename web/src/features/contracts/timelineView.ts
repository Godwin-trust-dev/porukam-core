/**
 * Хроники реального контура (ADR-134) — чистые помощники без React и без
 * словаря подписей. Один и тот же элемент отдают `GET /contracts/{id}/
 * timeline`, `/amendments/{id}/timeline` и `/milestones/{id}/timeline`
 * (общий `contracts_selectors.timeline_entries`), поэтому подпись строки
 * считается ЗДЕСЬ, а не на каждой странице отдельно.
 *
 * Подписи (`title`/`detail`) приходят С БЭКА локализованными (решение
 * владельца 26.08) — фронт НЕ ведёт `kind → i18n` и НЕ различает события по
 * `payload`. Здесь только: защитный фильтр чата, признак вложенности и
 * ссылка на сущность по `subject`.
 */
import type { TFunction } from 'i18next';
import type { RealTimelineEvent, RealTimelineSubject } from '@porukam/core';

/** Чат в хронику бэк больше не отдаёт (ADR-134); фильтр — защита от старого
 * ответа, чтобы переписка не сыпалась в юридически значимую ленту. */
const CHAT_TOPIC = 'message.created';

/** Стабильный ключ представления: `kind` (ADR-134) или `topic` у старого бэка. */
export function timelineKind(e: RealTimelineEvent): string {
  return e.kind ?? e.topic;
}

/** Подпись события с бэка. Старый бэк `title` не отдаёт; новый без текста в
 * паке отдаёт `title == kind` (`selectors._timeline_entry`) — оба случая
 * значат «подписи нет», код заголовком не печатаем. */
export function timelineTitle(e: RealTimelineEvent): string | null {
  const kind = timelineKind(e);
  return e.title && e.title !== kind ? e.title : null;
}

/** Готовая подпись строки для лент, чей рендер принимает ГОТОВУЮ строку
 * (`ContractTimeline` на экране этапа), в отличие от `RealTimelinePanel`, где
 * код события рисуется отдельным `<code>`. Порядок один и тот же: подпись
 * бэка (ADR-134, локализована по языку пользователя) → нейтральное «Событие»
 * → сам код, если и словаря интерфейса нет. Код события заголовком НЕ
 * печатаем: `milestone.submitted` в хронике этапа — находка 07.09. */
export function timelineTitleText(e: RealTimelineEvent, t: TFunction): string {
  const title = timelineTitle(e);
  if (title) return title;
  const fallback = t('contract.timeline.eventFallback');
  return fallback && fallback !== 'contract.timeline.eventFallback' ? fallback : timelineKind(e);
}

/** Пояснение строки: `detail` бэка, а без подписи — код события мелким
 * (там же, где в хронике договора стоит `<code>`), чтобы событие всё равно
 * можно было опознать. Актор НЕ показываем: у бэка это `{user_id}`
 * (`apps.milestones.services`), роли в нём нет — как и в хронике договора. */
export function timelineDetailText(e: RealTimelineEvent): string | undefined {
  if (e.detail) return e.detail;
  return timelineTitle(e) ? undefined : timelineKind(e);
}

export function isChatEvent(e: RealTimelineEvent): boolean {
  return timelineKind(e) === CHAT_TOPIC || e.topic === CHAT_TOPIC;
}

/** Вложенность — ТОЛЬКО по флагу бэка: у старого ответа все события
 * договорные (subject.type === 'contract'), догадок по subject не строим. */
export function isNestedEvent(e: RealTimelineEvent): boolean {
  return e.nested === true;
}

/** Куда ведёт событие дочерней сущности: маршрут страницы, либо вкладка
 * самой карточки (платежи живут во вкладке «Оплаты», своей страницы нет). */
export type TimelineSubjectLink = { to: string } | { tab: 'payments' } | null;

export function timelineSubjectLink(contractId: string, subject: RealTimelineSubject | null | undefined, payload?: unknown): TimelineSubjectLink {
  if (!subject || !subject.id) return null;
  switch (subject.type) {
    case 'warranty_claim': {
      // Своей страницы у претензии нет; если по ней открыт спор — бэк кладёт
      // `dispute_id` в payload события (решение владельца 26.08), ведём туда.
      const disputeId = (payload as { dispute_id?: unknown } | null | undefined)?.dispute_id;
      return typeof disputeId === 'string' && disputeId ? { to: `/disputes/${disputeId}` } : null;
    }
    case 'milestone':
      // Экран этапа реального контура — `/contracts/:id/stages/:sid` с id этапа
      // (так же ходит сводка этапов на обзоре карточки).
      return { to: `/contracts/${contractId}/stages/${subject.id}` };
    case 'amendment':
      return { to: `/contracts/${contractId}/amendments/${subject.id}` };
    case 'dispute':
      return { to: `/disputes/${subject.id}` };
    case 'payment':
      return { tab: 'payments' };
    default:
      return null;
  }
}

/** i18n-ключ типа сущности для подписи «Этап · 1a2b3c4d», когда бэк не дал
 * `subject.title`. Неизвестный тип — показываем как есть. */
const SUBJECT_LABEL_KEY: Record<string, string> = {
  milestone: 'contract.timeline.subject.milestone',
  amendment: 'contract.timeline.subject.amendment',
  dispute: 'contract.timeline.subject.dispute',
  payment: 'contract.timeline.subject.payment',
  warranty_claim: 'contract.timeline.subject.warranty_claim',
};

export function timelineSubjectLabelKey(type: string): string | null {
  return SUBJECT_LABEL_KEY[type] ?? null;
}

/** Короткий id для подписи сущности без названия (uuid → первые 8 символов). */
export function shortSubjectId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id;
}
