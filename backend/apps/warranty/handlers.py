"""Подписчики apps.warranty (settings.OUTBOX_SUBSCRIBERS):

- `dispute.resolved` — исход гарантийного разногласия — он же исход
  претензии. Реакция здесь, а не вызовом из `apps.disputes.services.
  resolve_dispute`: apps.disputes ничего не знает про apps.warranty (иначе
  связка стала бы двусторонней), а порядок «сначала спор, потом заявка»
  гарантируется тем, что событие публикуется уже после сохранения спора.
- `domain_deadline.fired`, kind=`warranty_claim_acceptance` (ADR-133) —
  окно подтверждения истекло молча -> авто-`warranty_satisfied`, тот же
  реестр и та же дискриминация по `payload["kind"]`, что у автоприёмки
  этапа (`apps.milestones.handlers.handle_deadline_fired`)."""

from __future__ import annotations

from apps.accounts.models import User
from common.models import OutboxEvent

from . import selectors, services
from .models import WarrantyClaim


def handle_dispute_resolved(event: OutboxEvent) -> None:
    payload = event.payload or {}
    if payload.get("dispute_kind") != "warranty":
        return
    dispute_id = payload.get("dispute_id")
    if not dispute_id:
        return
    claim = selectors.get_by_dispute(dispute_id)
    # Идемпотентность реле (ADR-064, at-least-once): повторная доставка на
    # уже закрытой заявке — NOOP, а не ClaimAlreadyResolvedError в очередь.
    if claim is None or claim.status == WarrantyClaim.Status.RESOLVED:
        return
    # Актор исхода спора — тот, кто закрыл претензию; пустой актор (потолок
    # 30 дней свипом) — автозакрытие (дополнение 26.08 к ADR-133).
    actor_user_id = (event.actor or {}).get("user_id")
    user = User.objects.filter(pk=actor_user_id).first() if actor_user_id else None
    services.resolve_warranty_claim(
        claim,
        resolution_type=str(payload.get("resolution_type") or ""),
        user=user,
        auto=not actor_user_id,
    )


def handle_deadline_fired(event: OutboxEvent) -> None:
    if event.payload.get("kind") != services.ACCEPTANCE_DEADLINE_KIND:
        return
    subject = event.subject or {}
    if subject.get("type") != "warranty_claim" or not subject.get("id"):
        return
    claim = selectors.get_claim(subject["id"])
    # Только претензия, всё ещё ждущая подтверждения, и только по ЕЁ текущему
    # окну: возражение заказчика снимает дедлайн паузой, но повторная
    # доставка старого события не должна закрыть новый раунд.
    if claim is None or claim.status != WarrantyClaim.Status.AWAITING_CONFIRMATION:
        return
    if str(claim.acceptance_deadline_id) != str(event.payload.get("deadline_id")):
        return
    services.auto_satisfy_warranty_claim(claim)
