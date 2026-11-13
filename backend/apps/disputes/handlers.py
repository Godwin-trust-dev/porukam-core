"""Подписчики apps.disputes (settings.OUTBOX_SUBSCRIBERS):

- `domain_deadline.fired` — три категории сразу, дискриминация по
  `payload["kind"]` (тот же приём, что `apps.contracts.handlers`):
  `dispute_cap` (ADR-020, потолок 30 дней) -> авто-исход `cap_reached`;
  `dispute_response_window`/`termination_dispute_window` (ADR-019) -> окно
  истекло без возражений, факт зафиксирован.
- `milestone.rejected` — ОТКРЫВАЕТ спор (`services.open_dispute`). Не прямой
  вызов из `apps.milestones.services.reject_milestone`: import-linter
  запрещает это транзитивно (apps.contracts -> apps.milestones ->
  apps.disputes); apps.disputes ЗАКОННО импортирует apps.milestones — только
  не наоборот.
- `contract.amended` — допник подписан обеими сторонами; если это был допник
  СКИДКИ по спору (ADR-131), спор закрывается исходом `discount_accepted`.
  Направление тоже через outbox, а не вызовом из apps.contracts (тот же
  запрет import-linter).
- `amendment.rejected` / `amendment.withdrawn` (дополнение 26.08 к ADR-075) —
  допник СКИДКИ отклонён/отозван контуром §8.6 -> предложение `declined`,
  спор из `awaiting_discount` обратно в `open` (не висит без живого допника).
- `contract.terminated` с `terminated_by=contractor` — ADR-028: расторжение
  исполнителем «не свободное право, проходит через окно оспаривания» ->
  открываем окно `termination_notice`.
"""

from __future__ import annotations

from apps.accounts.models import User
from apps.contracts.models import Amendment, Contract
from apps.milestones.models import ChecklistItem, Milestone
from common.models import OutboxEvent

from . import services
from .models import Dispute, DisputeWindow

_DISPUTE_CAP_KIND = "dispute_cap"
_WINDOW_KINDS_BY_DEADLINE: dict[str, str] = {
    "dispute_response_window": DisputeWindow.Kind.DISPUTE_RESPONSE,
    "termination_dispute_window": DisputeWindow.Kind.TERMINATION_NOTICE,
}


def handle_deadline_fired(event: OutboxEvent) -> None:
    kind = event.payload.get("kind")
    if kind == _DISPUTE_CAP_KIND:
        _handle_cap_reached(event)
    elif kind in _WINDOW_KINDS_BY_DEADLINE:
        _handle_window_expired(event, window_kind=_WINDOW_KINDS_BY_DEADLINE[str(kind)])


def _handle_cap_reached(event: OutboxEvent) -> None:
    subject = event.subject or {}
    if subject.get("type") != "dispute":
        return
    dispute_id = subject.get("id")
    if not dispute_id:
        return
    dispute = (
        Dispute.objects.filter(pk=dispute_id)
        .select_related("contract", "milestone", "checklist_item")
        .first()
    )
    if dispute is None or dispute.status == Dispute.Status.RESOLVED:
        return
    services.resolve_dispute(dispute, user=None, resolution_type="cap_reached")


def _handle_window_expired(event: OutboxEvent, *, window_kind: str) -> None:
    """Дедлайн окна лежит на субъекте СОБЫТИЯ (спор/договор), а не на самом
    окне — иначе якорить его размещением уведомления было бы нечем (см.
    докстринг `services.open_window`). Поэтому окно ищем по `deadline_id`."""
    deadline_id = (event.payload or {}).get("deadline_id")
    if not deadline_id:
        return
    window = DisputeWindow.objects.filter(
        deadline_id=deadline_id, kind=window_kind, closed_at__isnull=True
    ).first()
    if window is None:
        return
    services.expire_window(window)


def handle_milestone_rejected(event: OutboxEvent) -> None:
    payload = event.payload or {}
    milestone_id = payload.get("milestone_id")
    checklist_item_id = payload.get("checklist_item_id")
    evidence = payload.get("evidence") or []
    actor_user_id = (event.actor or {}).get("user_id")
    if not (milestone_id and checklist_item_id and actor_user_id):
        return

    milestone = Milestone.objects.filter(pk=milestone_id).select_related("contract").first()
    checklist_item = ChecklistItem.objects.filter(pk=checklist_item_id).first()
    user = User.objects.filter(pk=actor_user_id).first()
    if milestone is None or checklist_item is None or user is None:
        return
    # Идемпотентность реле (ADR-064: at-least-once, событие может прийти
    # повторно, если другой подписчик того же топика тогда упал) — незакрытый
    # спор на этот пункт чек-листа уже есть -> вторая доставка NOOP. Проверка
    # «не resolved», а не «status == open»: спор мог уже уйти в раунд
    # исправления или в ожидание решения по скидке.
    if (
        Dispute.objects.filter(milestone=milestone, checklist_item=checklist_item)
        .exclude(status=Dispute.Status.RESOLVED)
        .exists()
    ):
        return
    services.open_dispute(milestone, user=user, checklist_item=checklist_item, evidence=evidence)


def handle_contract_amended(event: OutboxEvent) -> None:
    """Допник вступил в силу. Если это допник скидки по спору — фиксируем
    исход `discount_accepted` и закрываем спор; иначе (обычный допник §8.6)
    `accept_discount_by_amendment` вернёт None и ничего не произойдёт."""
    amendment_id = (event.payload or {}).get("amendment_id")
    if not amendment_id:
        return
    amendment = Amendment.objects.filter(pk=amendment_id).select_related("contract").first()
    if amendment is None:
        return
    services.accept_discount_by_amendment(
        amendment, actor_user_id=(event.actor or {}).get("user_id")
    )


def handle_amendment_closed(event: OutboxEvent) -> None:
    """Допник отозван (`amendment.withdrawn`) или отклонён
    (`amendment.rejected`) — если это допник скидки по спору, спор
    возвращается в `open`. Субъект события — сам допник; contracts про
    disputes не знает (import-linter), связка ищется здесь по
    `DiscountAgreement.amendment`."""
    subject = event.subject or {}
    if subject.get("type") != "amendment" or not subject.get("id"):
        return
    amendment = Amendment.objects.filter(pk=subject["id"]).select_related("contract").first()
    if amendment is None:
        return
    services.cancel_discount_by_amendment(
        amendment,
        actor_user_id=(event.actor or {}).get("user_id"),
        cause=event.topic.split(".", 1)[-1],
    )


def handle_contract_terminated(event: OutboxEvent) -> None:
    """ADR-028: расторжение ЗАКАЗЧИКОМ — безусловное право, окна не требует;
    расторжение ИСПОЛНИТЕЛЕМ — «требует основания, проходит через окно
    оспаривания». Окно открывается здесь, а не в `apps.contracts.services.
    terminate_by_contractor`: contracts не имеет права знать про disputes
    (import-linter)."""
    payload = event.payload or {}
    if payload.get("terminated_by") != "contractor":
        return
    subject = event.subject or {}
    contract_id = subject.get("id") if subject.get("type") == "contract" else None
    if not contract_id:
        return
    contract = Contract.objects.filter(pk=contract_id).first()
    if contract is None:
        return
    # Идемпотентность реле: окно на это расторжение уже открыто -> NOOP.
    if DisputeWindow.objects.filter(
        contract=contract, kind=DisputeWindow.Kind.TERMINATION_NOTICE
    ).exists():
        return
    services.open_window(
        kind=DisputeWindow.Kind.TERMINATION_NOTICE,
        contract=contract,
        dispute=None,
        subject_type="contract",
        subject_id=contract.id,
    )
