"""Реестр доменных событий apps.contracts и производный ключ представления
хроники (`kind`) — ADR-134.

Две вещи в одном модуле, потому что это две стороны одной таблицы:

- `Topic` — ВСЕ topic'и, которые публикует `apps.contracts.services`
  (tech-spec.md §6.4: реестр в спецификации был «неполным» и содержал
  неэмитируемые коды; здесь — фактический). Строковые литералы в `publish`
  запрещены — тест `test_timeline.py::test_every_published_topic_is_in_registry`
  сверяет исходник services.py с реестром.
- `timeline_kind()` — стабильный ключ представления элемента хроники
  (`GET /contracts/{id}/timeline`). Один topic может нести несколько смыслов,
  различимых только по payload (`negotiation.revised` — предложить/принять/
  отклонить/встречная/«принять все»/альтернатива; `domain_deadline.fired` —
  гарантия истекла/окно оспаривания расторжения закрылось). Фронт по `kind`
  подбирает подпись; когда появится экспорт архива Э6, `kind` станет ключом
  шаблона в l10n-паках. `topic`/`payload` в ответе остаются как есть.

Чужие topic'и (`milestone.*`, `dispute.*`, `payment.*`, `warranty.*`) здесь
только ПЕРЕЧИСЛЕНЫ строками — как ключи, по которым хроника договора
свёртывает ключевые события дочерних сущностей из той же outbox-таблицы
(contracts не импортирует payments/disputes — import-linter). Владелец
topic'а — издатель; переименование там ломает тест `test_timeline.py`
осознанно.
"""

from __future__ import annotations

from enum import StrEnum
from typing import Any


class Topic(StrEnum):
    """Topic'и, публикуемые apps.contracts (по порядку жизненного цикла)."""

    # Черновик
    CONTRACT_DRAFTED = "contract.drafted"
    CONTRACT_DRAFT_PATCHED = "contract.draft_patched"
    CONTRACT_DRAFT_DELETED = "contract.draft_deleted"
    # Согласование (NEGOTIATION_FSM), Э4.2
    NEGOTIATION_SENT = "negotiation.sent"
    NEGOTIATION_WITHDRAWN = "negotiation.withdrawn"
    NEGOTIATION_REJECTED = "negotiation.rejected"
    NEGOTIATION_REOPENED = "negotiation.reopened"
    NEGOTIATION_REVISED = "negotiation.revised"
    # Заморозка и подписание, Э4.4
    NEGOTIATION_FROZEN = "negotiation.frozen"
    NEGOTIATION_SIGNATURE_REQUESTED = "negotiation.signature_requested"
    NEGOTIATION_SIGNED = "negotiation.signed"
    NEGOTIATION_SIGNATURE_FORWARDED = "negotiation.signature_forwarded"
    NEGOTIATION_SIGNATURE_REQUEST_EXPIRED = "negotiation.signature_request_expired"
    CONTRACT_SIGNED = "contract.signed"
    # Допники, Э4.5 (subject.type = amendment; `contract.amended` — на договоре)
    AMENDMENT_DRAFTED = "amendment.drafted"
    AMENDMENT_SENT = "amendment.sent"
    AMENDMENT_FROZEN = "amendment.frozen"
    AMENDMENT_SIGNATURE_REQUESTED = "amendment.signature_requested"
    AMENDMENT_SIGNED = "amendment.signed"
    AMENDMENT_SIGNATURE_FORWARDED = "amendment.signature_forwarded"
    AMENDMENT_REOPENED = "amendment.reopened"
    AMENDMENT_SIGNATURE_REQUEST_EXPIRED = "amendment.signature_request_expired"
    # Заведены заранее под `feat/contracts-amendment-reject` (отклонить /
    # отозвать допник) — хроника уже умеет их свёртывать.
    AMENDMENT_REJECTED = "amendment.rejected"
    AMENDMENT_WITHDRAWN = "amendment.withdrawn"
    CONTRACT_AMENDED = "contract.amended"
    # Исполнение, Э4.6
    CONTRACT_STARTED = "contract.started"
    CONTRACT_COMPLETED = "contract.completed"
    CONTRACT_WARRANTY_STARTED = "contract.warranty_started"
    CONTRACT_CLOSED = "contract.closed"
    CONTRACT_TERMINATED = "contract.terminated"
    # ADR-138: сделка без движения — системные события (actor пустой).
    CONTRACT_IDLE_BLOCKED = "contract.idle_blocked"
    CONTRACT_AUTO_CLOSED = "contract.auto_closed"


# --- Чужие topic'и, участвующие в хронике договора ---------------------------

# Чат — не хроника (решение владельца 26.08, docs/backlog.md): у переписки
# своя вкладка, в ленте юрзначимых фактов сообщения — шум.
MESSAGE_CREATED = "message.created"
EXCLUDED_TOPICS: frozenset[str] = frozenset({MESSAGE_CREATED})

# Сработавший доменный дедлайн (apps.deadlines.tasks) — subject тот, на кого
# дедлайн ставили; на договоре это `kind=contract_warranty` (гарантия
# истекла, services.complete_execution) и `kind=termination_dispute_window`
# (окно оспаривания расторжения закрылось, apps.disputes.handlers).
DOMAIN_DEADLINE_FIRED = "domain_deadline.fired"
_DEADLINE_KINDS: dict[str, str] = {
    "contract_warranty": "deadline.warranty_expired",
    "termination_dispute_window": "deadline.termination_window_closed",
}

# Ключевые события дочерних сущностей, свёрнутые в хронику договора
# (`nested: true`). Не все: `milestone.gate_passed/suspended/resumed/
# checklist_*`, `payment.created/payer_confirmed/…`, `dispute.responded/
# fix_*` — рабочий шум, он остаётся в ленте самой сущности
# (`/milestones/{id}/timeline` и т.п.). `milestone.paid` намеренно НЕ
# включён: тот же факт публикует `payment.paid` (apps.payments зеркалит
# подтверждение в milestones, оба события летят в одной транзакции), а
# деньги — сущность платежей.
NESTED_TOPICS: tuple[str, ...] = (
    # этапы
    "milestone.started",
    "milestone.submitted",
    "milestone.accepted",
    "milestone.auto_accepted",
    "milestone.rejected",
    # ADR-157 (замечание владельца 03.09: правки материалов в согласовании
    # проходят без раунда — вторая сторона должна видеть их в ленте самого
    # ДОГОВОРА, а не только открыв этап). Это исключение из правила «в
    # хронику договора — только ключевые точки»: до подписания материалы
    # входят в текст договора и в хеш замороженной версии, значит их правка
    # — не рабочий шум, а изменение предмета сделки. Подписи —
    # `ui.timeline.milestone.material_*` (те же ключи, что у хроники ЭТАПА,
    # ADR-156: один смысл — один ключ, дублировать на 29 языков нечего).
    "milestone.material_added",
    "milestone.material_updated",
    "milestone.material_removed",
    # допники (subject.type = amendment, contract_id в payload)
    Topic.AMENDMENT_SENT,
    Topic.AMENDMENT_REJECTED,
    Topic.AMENDMENT_WITHDRAWN,
    # споры
    "dispute.opened",
    "dispute.resolved",
    # платежи
    "payment.paid",
    # гарантия
    "warranty.claim_submitted",
    "warranty.claim_declined",
    "warranty.claim_resolved",
)


# --- kind ---------------------------------------------------------------------

# `negotiation.revised`: payload.action (6 сайтов публикации в services.py).
_REVISED_ACTIONS: dict[str, str] = {
    "proposed": "negotiation.revised.proposed",
    "accepted": "negotiation.revised.accepted",
    "rejected": "negotiation.revised.rejected",
    "countered": "negotiation.revised.countered",
    "preapproved_applied": "negotiation.revised.alternative",
}
_REVISED_ACCEPT_ALL = "negotiation.revised.accept_all"

# `negotiation.reopened`: payload.reason — инициатор вернул на доработку сам
# (`return_for_revision`) или подписант отклонил подписание (`decline`).
_REOPENED_REASONS: dict[str, str] = {
    "returned_for_revision": "negotiation.reopened.returned",
    "declined_for_revision": "negotiation.reopened.declined",
}

# `contract.terminated`: payload.terminated_by.
_TERMINATED_BY: dict[str, str] = {
    "customer": "contract.terminated.by_customer",
    "contractor": "contract.terminated.by_contractor",
}


def timeline_kind(topic: str, payload: dict[str, Any] | None) -> str:
    """Стабильный ключ представления элемента хроники (ADR-134). Для topic'ов
    с одним смыслом `kind == topic`; для «многозначных» — суффикс по payload.
    Событие без различительного поля (старые строки outbox, чужой издатель)
    честно остаётся под своим topic'ом — подпись у фронта будет общей, но
    элемент не потеряется."""
    data = payload or {}
    if topic == Topic.NEGOTIATION_REVISED:
        action = data.get("action")
        if action == "accepted" and data.get("via") == "accept_all":
            return _REVISED_ACCEPT_ALL
        return _REVISED_ACTIONS.get(str(action), topic)
    if topic == Topic.NEGOTIATION_REOPENED:
        return _REOPENED_REASONS.get(str(data.get("reason")), topic)
    if topic == Topic.CONTRACT_TERMINATED:
        return _TERMINATED_BY.get(str(data.get("terminated_by")), topic)
    if topic == DOMAIN_DEADLINE_FIRED:
        return _DEADLINE_KINDS.get(str(data.get("kind")), topic)
    return topic


def _own_timeline_kinds() -> tuple[str, ...]:
    """Полный список значений `kind`, которые может отдать хроника
    (реестр для фронта/l10n; порядок — жизненный цикл)."""
    kinds: list[str] = []
    for topic in Topic:
        if topic == Topic.NEGOTIATION_REVISED:
            kinds += [*_REVISED_ACTIONS.values()]
            kinds.insert(kinds.index("negotiation.revised.alternative"), _REVISED_ACCEPT_ALL)
        elif topic == Topic.NEGOTIATION_REOPENED:
            kinds += [*_REOPENED_REASONS.values()]
        elif topic == Topic.CONTRACT_TERMINATED:
            kinds += [*_TERMINATED_BY.values()]
        else:
            kinds.append(str(topic))
    kinds += [*_DEADLINE_KINDS.values()]
    kinds += [t for t in NESTED_TOPICS if t not in kinds]
    return tuple(kinds)


TIMELINE_KINDS: tuple[str, ...] = _own_timeline_kinds()


# --- Подписи (ADR-134: подпись отдаёт API, фронт не переводит) ---------------

# Ключи в l10n-паках: `ui.timeline.<kind>` — заголовок, `ui.timeline.<kind>
# .detail` — короткая подпись с подстановками из payload (необязательна).
TIMELINE_TEXT_PREFIX = "timeline."
TIMELINE_DETAIL_SUFFIX = ".detail"


def timeline_title_key(kind: str) -> str:
    return f"{TIMELINE_TEXT_PREFIX}{kind}"


def timeline_detail_key(kind: str) -> str:
    return f"{TIMELINE_TEXT_PREFIX}{kind}{TIMELINE_DETAIL_SUFFIX}"


def timeline_detail_vars(payload: dict[str, Any] | None) -> dict[str, str]:
    """Подстановки для `detail` — только непустые строки из payload события
    (ничего не читаем из БД). Имена = плейсхолдеры в паках (EN-канон):
    `{milestone_title}`, `{item}` (item_ref правки), `{amount}`, `{currency}`,
    `{comment}`, `{reason}`, `{description}`."""
    data = payload or {}
    raw = {
        "milestone_title": data.get("milestone_title"),
        "item": data.get("item_ref"),
        "amount": data.get("amount"),
        "currency": data.get("currency"),
        "comment": data.get("comment"),
        "reason": data.get("reason"),
        "description": data.get("description"),
    }
    return {k: v.strip() for k, v in raw.items() if isinstance(v, str) and v.strip()}


class _StrictVars(dict[str, str]):
    def __missing__(self, key: str) -> str:
        raise KeyError(key)


def render_timeline_detail(template: str | None, payload: dict[str, Any] | None) -> str | None:
    """`detail` по шаблону из пака; нет шаблона или в payload нет значения
    для плейсхолдера (гарантийный спор без этапа, пустой комментарий) —
    `None`, а не подпись с дыркой."""
    if not template:
        return None
    try:
        return template.format_map(_StrictVars(timeline_detail_vars(payload)))
    except (KeyError, IndexError, ValueError):
        return None
