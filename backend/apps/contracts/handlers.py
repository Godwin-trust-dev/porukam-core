"""Подписчик apps.contracts на topic=`domain_deadline.fired` (apps.deadlines
sweep, ЭФ.2) — реагирует на срабатывание `kind=signature_request_expiry`
(созданного `services.route_signatory`/`route_amendment_signatory`)
переводом соответствующего `SignatureRequest` в `expired` (etap-4.md Э4.4:
«expire — истечение через deadlines»); И на `kind=contract_warranty`
(Э4.6, `services.complete_execution`) — перевод договора `warranty -> closed`
по дате. Регистрируется в `settings.OUTBOX_SUBSCRIBERS["domain_deadline.fired"]`
рядом с `apps.deadlines.handlers.log_fired_deadline` (тот же приём, что
`apps.profiles.subscriber` на топик `social.consent_recorded`).

Диспетчеризация по `request.amendment_id` (Э4.5): запрос про допник ->
`expire_amendment_signature_request`, про сам договор ->
`expire_signature_request` — та же развилка, что дуальные вьюхи sign/
forward/decline (`apps.contracts.api.views`).

ADR-138 добавил сюда же `kind=contract_idle`/`contract_idle_retry` ->
`services.auto_close_idle_contract` и ВТОРОЙ подписчик —
`handle_contract_activity` на ключе «*» реестра: любое действие стороны по
договору (событие с `actor.user_id` из семейств договорного контура)
двигает `Contract.last_activity_at` и переносит дедлайн idle. Договор
берётся из `subject`/`payload` события — чужие модели не импортируются."""

from __future__ import annotations

from uuid import UUID

from apps.deadlines import selectors as deadlines_selectors
from common.models import OutboxEvent

from . import services
from .models import Contract, SignatureRequest

_SIGNATURE_REQUEST_EXPIRY_KIND = "signature_request_expiry"
_CONTRACT_WARRANTY_KIND = "contract_warranty"
_IDLE_KINDS = (services.IDLE_DEADLINE_KIND, services.IDLE_RETRY_DEADLINE_KIND)

# Семейства событий, которые считаются движением по договору (ADR-137
# «любая активность по сделке, включая сообщения в чате»). Не список
# топиков, а префиксы: новый топик семейства (скажем, следующий dispute.*)
# должен считаться движением сам собой, без правки реестра здесь.
ACTIVITY_TOPIC_FAMILIES = (
    "contract.",
    "negotiation.",
    "amendment.",
    "milestone.",
    "payment.",
    "dispute.",
    "evidence.",
    "message.",
    "warranty.",
)


def handle_deadline_fired(event: OutboxEvent) -> None:
    kind = event.payload.get("kind")
    if kind == _SIGNATURE_REQUEST_EXPIRY_KIND:
        _handle_signature_request_expiry(event)
    elif kind == _CONTRACT_WARRANTY_KIND:
        _handle_contract_warranty_expiry(event)
    elif kind in _IDLE_KINDS:
        _handle_contract_idle(event)


def _event_contract_id(event: OutboxEvent) -> UUID | None:
    """Договор события — тот же резолв, что у `apps.notifications.subscriber.
    _event_contract_id`: subject.id при type=contract, иначе
    subject.contract_id (этапы/споры/доказательства/претензии), иначе
    payload.contract_id (допники, платежи)."""
    subject = event.subject or {}
    raw = subject.get("id") if subject.get("type") == "contract" else None
    raw = raw or subject.get("contract_id") or (event.payload or {}).get("contract_id")
    if not raw:
        return None
    try:
        return UUID(str(raw))
    except ValueError:
        return None


def handle_contract_activity(event: OutboxEvent) -> None:
    """Подписчик «*»: движение по договору (ADR-138 §1). Считается только
    ДЕЙСТВИЕ СТОРОНЫ — событие с `actor.user_id`; системные события (свип
    дедлайнов, автоприёмка, `payment.overdue`, само `contract.auto_closed`)
    актора не имеют и метку не двигают: иначе автоприёмка по тайм-ауту
    «оживляла» бы договор, по которому никто ничего не делает. Момент
    движения — `occurred_at` события, не время доставки."""
    if not (event.actor or {}).get("user_id"):
        return
    if not event.topic.startswith(ACTIVITY_TOPIC_FAMILIES):
        return
    contract_id = _event_contract_id(event)
    if contract_id is None:
        return
    contract = Contract.objects.filter(pk=contract_id).first()
    if contract is None:
        return
    services.record_contract_activity(contract, at=event.occurred_at)


def _handle_contract_idle(event: OutboxEvent) -> None:
    subject = event.subject or {}
    if subject.get("type") != "contract":
        return
    subject_id = subject.get("id")
    deadline_id = event.payload.get("deadline_id")
    if not subject_id or not deadline_id:
        return
    contract = Contract.objects.filter(pk=subject_id).first()
    deadline = deadlines_selectors.get_deadline(UUID(str(deadline_id)))
    if contract is None or deadline is None:
        return
    services.auto_close_idle_contract(contract, deadline=deadline)


def _handle_signature_request_expiry(event: OutboxEvent) -> None:
    subject = event.subject or {}
    if subject.get("type") != "signature_request":
        return
    subject_id = subject.get("id")
    if not subject_id:
        return
    request = (
        SignatureRequest.objects.filter(pk=subject_id)
        .select_related("contract", "amendment")
        .first()
    )
    if request is None:
        return
    if request.amendment_id is not None:
        services.expire_amendment_signature_request(request)
    else:
        services.expire_signature_request(request)


def _handle_contract_warranty_expiry(event: OutboxEvent) -> None:
    subject = event.subject or {}
    if subject.get("type") != "contract":
        return
    subject_id = subject.get("id")
    if not subject_id:
        return
    contract = Contract.objects.filter(pk=subject_id).first()
    if contract is None or contract.execution_status != Contract.ExecutionStatus.WARRANTY:
        return
    services.close_contract(contract)
