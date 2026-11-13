"""Подписчики apps.milestones на outbox-события чужих доменов (Э4.6,
docs/tasks/etap-4.md):

- `domain_deadline.fired`, `kind=milestone_acceptance` — автоприёмка по
  sweep после серии напоминаний (тот же реестр `settings.OUTBOX_SUBSCRIBERS
  ["domain_deadline.fired"]`, что `apps.deadlines.handlers.log_fired_deadline`
  и `apps.contracts.handlers.handle_deadline_fired`, дискриминация по
  `payload["kind"]`).
- `dispute.resolved`, `resolution_type in {"accepted","withdrawn",
  "discount_accepted"}` — исход диалога возвращает этап в `accepted`
  (`apps.disputes` НИКОГДА не импортирует apps.milestones.services —
  реакция здесь, не там, см. докстринг apps/disputes/models.py: разрыв
  цикла через outbox, тот же приём, что apps.profiles на `entity.claimed`).
- `dispute.fix_resubmitted` (этап 7, ADR-131) — «Исправление сдано -> снова
  `under_acceptance`» (tech-spec.md §8.8): тот же разрыв цикла, окно приёмки
  открывается заново вместе с серией напоминаний.
- `contract.signed` (ADR-162) — подпись закрыла ПОСЛЕДНЕЕ условие гейта
  §6.3: листья, которым не нужны ни материалы заказчика, ни оплата до
  старта, входят в работу сами. Реакция ЗДЕСЬ, а не в
  `apps.contracts.services.sign`: зависимость направлена
  `apps.milestones -> apps.contracts`, обратный импорт запрещён
  import-linter (тот же приём, что у `handle_dispute_resolved`)."""

from __future__ import annotations

from uuid import UUID

from apps.accounts.models import User
from common.models import OutboxEvent

from . import services
from .models import Milestone

_MILESTONE_ACCEPTANCE_KIND = "milestone_acceptance"
# Исходы ДИАЛОГА — этап принимается. `cap_reached` (ADR-020) сюда НЕ входит
# осознанно: «спорный этап целиком остаётся неоплаченным», он и остаётся
# `disputed`. `escalated_to_court` — тоже: платформа не решает спор за суд.
# `discount_accepted` (ADR-131) входит: скидка = подписанный ОБЕИМИ
# сторонами допник, сумма листа уже уменьшена, работа принята по новой цене.
_DISPUTE_RESOLUTIONS_RETURNING_TO_ACCEPTED = frozenset(
    {"accepted", "withdrawn", "discount_accepted"}
)


def handle_deadline_fired(event: OutboxEvent) -> None:
    if event.payload.get("kind") != _MILESTONE_ACCEPTANCE_KIND:
        return
    subject = event.subject or {}
    if subject.get("type") != "milestone":
        return
    milestone_id = subject.get("id")
    if not milestone_id:
        return
    milestone = Milestone.objects.filter(
        pk=milestone_id, status=Milestone.Status.UNDER_ACCEPTANCE
    ).first()
    if milestone is None:
        return
    services.finalize_acceptance(milestone, actor_user=None, auto=True)


def handle_dispute_resolved(event: OutboxEvent) -> None:
    resolution_type = (event.payload or {}).get("resolution_type")
    if resolution_type not in _DISPUTE_RESOLUTIONS_RETURNING_TO_ACCEPTED:
        return
    milestone_id = (event.payload or {}).get("milestone_id")
    if not milestone_id:
        return
    milestone = Milestone.objects.filter(pk=milestone_id, status=Milestone.Status.DISPUTED).first()
    if milestone is None:
        return
    services.finalize_acceptance(milestone, actor_user=None, auto=False)


def handle_dispute_fix_resubmitted(event: OutboxEvent) -> None:
    """Этап 7 (ADR-131, tech-spec.md §8.8): «Исправление сдано -> снова
    `under_acceptance`». Тот же приём разрыва цикла, что у
    `handle_dispute_resolved`: реакция ЗДЕСЬ, а не вызов apps.milestones из
    apps.disputes. Идемпотентность реле (ADR-064) — фильтр по статусу
    `disputed`: повторная доставка события уже переведённого этапа не найдёт
    строку и молча выйдет."""
    payload = event.payload or {}
    milestone_id = payload.get("milestone_id")
    if not milestone_id:
        return
    milestone = (
        Milestone.objects.filter(pk=milestone_id, status=Milestone.Status.DISPUTED)
        .select_related("contract")
        .first()
    )
    if milestone is None:
        return
    contractor_user = None
    actor_id = (event.actor or {}).get("user_id")
    if actor_id:
        contractor_user = User.objects.filter(pk=actor_id).first()
    services.return_to_acceptance_after_fix(milestone, contractor_user=contractor_user)


def handle_contract_signed(event: OutboxEvent) -> None:
    """ADR-162: договор подписан -> автостарт всех готовых листьев.

    Идемпотентность реле (ADR-064) — в самом сервисе: `auto_start_ready_
    leaves` перебирает только `pending` листья и берёт `select_for_update`
    на каждом, поэтому повторная доставка события ничего не находит и не
    публикует вторых `milestone.started`."""
    subject = event.subject or {}
    raw = subject.get("id") if subject.get("type") == "contract" else subject.get("contract_id")
    raw = raw or (event.payload or {}).get("contract_id")
    if not raw:
        return
    try:
        contract_id = UUID(str(raw))
    except (TypeError, ValueError):
        return
    services.auto_start_ready_leaves(contract_id)
