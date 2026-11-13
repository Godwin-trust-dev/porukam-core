"""Подписчик apps.reputation на события-исходы Э4.6 (docs/tasks/
global-wave.md ГВ.4): `milestone.accepted`, `milestone.auto_accepted`,
`milestone.rejected`, `dispute.opened`, `dispute.resolved`,
`contract.completed` — регистрируется в `settings.OUTBOX_SUBSCRIBERS`.

Идемпотентность — ДВЕ строки защиты, а не одна:
1. `handle_event` целиком отбивает уже обработанный `event_id`
   (`ProcessedEvent`) ДО того, как трогает `DealFact` — редоставленное
   (ADR-064: «at-least-once на уровне события», relay.py) событие не
   удваивает счётчики.
2. Каждый `update_or_create`/`get_or_create` внутри — тоже безопасен сам
   по себе (защита №2 — не полагаться ТОЛЬКО на защиту №1, тот же приём
   дублирующей защиты, что `apps.disputes.handlers.handle_milestone_rejected`)."""

from __future__ import annotations

from datetime import datetime
from decimal import Decimal
from typing import Any

from django.db import transaction

from apps.profiles import services as profiles_services
from apps.profiles.models import Profile
from common.models import OutboxEvent

from .models import DealFact, MilestoneFact, ProcessedEvent

_ACCEPTED_TOPICS = {"milestone.accepted", "milestone.auto_accepted"}


def _parse_dt(value: str | None) -> datetime | None:
    if not value:
        return None
    return datetime.fromisoformat(value)


def _party_profile_ids(parties: dict[str, Any]) -> tuple[str | None, str | None]:
    customer = (parties.get("customer") or {}).get("profile_id")
    contractor = (parties.get("contractor") or {}).get("profile_id")
    return customer, contractor


def _get_or_init_deal(contract_id: str) -> DealFact:
    deal, _created = DealFact.objects.get_or_create(contract_id=contract_id)
    return deal


def _touch_period(deal: DealFact, occurred_at: datetime | None) -> None:
    if occurred_at is None:
        return
    if deal.period_start is None or occurred_at < deal.period_start:
        deal.period_start = occurred_at
    if deal.period_end is None or occurred_at > deal.period_end:
        deal.period_end = occurred_at


def _apply_parties_and_sphere(deal: DealFact, payload: dict[str, Any]) -> None:
    customer_id, contractor_id = _party_profile_ids(payload.get("parties") or {})
    if customer_id:
        deal.customer_profile_id = customer_id
    if contractor_id:
        deal.contractor_profile_id = contractor_id
    sphere_code = payload.get("milestone_sphere_code")
    if sphere_code and sphere_code not in deal.sphere_codes:
        deal.sphere_codes = [*deal.sphere_codes, sphere_code]
    title = payload.get("milestone_title")
    if title:
        deal.last_milestone_title = title


# ---------------------------------------------------------------------------
# ADR-163 (макет владельца 05.09), волна 2 — оси сроков по роли
# ---------------------------------------------------------------------------


def _get_or_init_milestone_fact(payload: dict[str, Any]) -> MilestoneFact | None:
    """Строка `MilestoneFact` этапа из payload. `None` — событие без
    `milestone_id` (такого в топиках этапов не бывает, но подписчик обязан
    переживать чужой/усечённый payload молча, а не ронять релей)."""
    milestone_id = payload.get("milestone_id")
    contract_id = payload.get("contract_id")
    if not milestone_id or not contract_id:
        return None
    fact, _created = MilestoneFact.objects.get_or_create(
        milestone_id=milestone_id, defaults={"contract_id": contract_id}
    )
    customer_id, contractor_id = _party_profile_ids(payload.get("parties") or {})
    if customer_id:
        fact.customer_profile_id = customer_id
    if contractor_id:
        fact.contractor_profile_id = contractor_id
    if payload.get("milestone_title"):
        fact.title = payload["milestone_title"]
    if payload.get("milestone_sphere_code"):
        fact.sphere_code = payload["milestone_sphere_code"]
    if payload.get("due_at"):
        fact.due_at = _parse_dt(payload.get("due_at"))
    if payload.get("submitted_at"):
        fact.submitted_at = _parse_dt(payload.get("submitted_at"))
    return fact


def _delivered_on_time(fact: MilestoneFact) -> bool | None:
    """Ось ИСПОЛНИТЕЛЯ «сделано в срок». `None` — мерить нечего: у этапа
    не было дедлайна либо момент сдачи не пришёл. Именно `None`, а не
    `False`: этап без срока не «просрочен», он вне этой доли (иначе
    договоры без дедлайнов красили бы карточку в красное)."""
    if fact.due_at is None or fact.submitted_at is None:
        return None
    return fact.submitted_at <= fact.due_at


def recompute_deal_counters(deal: DealFact) -> None:
    """Счётчики `DealFact` ПРИСВАИВАЮТСЯ из строк `MilestoneFact` этого
    договора, а не инкрементируются. Отсюда два свойства сразу:
    повторный прогон (редоставка события, бэкфилл) не удваивает цифру, и
    денормализация не может разъехаться со строками, из которых она
    считается (ADR-163 §9)."""
    rows = list(MilestoneFact.objects.filter(contract_id=deal.contract_id))
    deal.milestones_with_due = sum(1 for r in rows if r.delivered_on_time is not None)
    deal.milestones_on_time = sum(1 for r in rows if r.delivered_on_time is True)
    deal.payments_with_due = sum(1 for r in rows if r.payment_on_time is not None)
    deal.payments_on_time = sum(1 for r in rows if r.payment_on_time is True)
    deal.acceptances_measured = sum(1 for r in rows if r.acceptance_prompt is not None)
    deal.acceptances_prompt = sum(1 for r in rows if r.acceptance_prompt is True)


def _handle_milestone_accepted(event: OutboxEvent) -> None:
    payload = event.payload or {}
    contract_id = payload.get("contract_id")
    if not contract_id:
        return
    deal = _get_or_init_deal(contract_id)
    _apply_parties_and_sphere(deal, payload)
    _touch_period(deal, _parse_dt(payload.get("occurred_at")))
    deal.milestones_accepted += 1

    fact = _get_or_init_milestone_fact(payload)
    if fact is not None:
        fact.accepted_at = _parse_dt(payload.get("accepted_at"))
        fact.auto_accepted = bool(payload.get("auto_accepted"))
        fact.delivered_on_time = _delivered_on_time(fact)
        # Ось ЗАКАЗЧИКА «принято без затягивания»: автоприёмка по тайм-ауту
        # — это НЕ «принято вовремя», сколько бы ни показывал `on_time`
        # (ADR-163 §1: один факт, две стороны). `on_time=None` — окна
        # приёмки не было (незаякоренный дедлайн): мерить нечего.
        on_time = payload.get("on_time")
        if fact.auto_accepted:
            fact.acceptance_prompt = False
        elif on_time is None:
            fact.acceptance_prompt = None
        else:
            fact.acceptance_prompt = bool(on_time)
        fact.save()
        recompute_deal_counters(deal)
    deal.save()


def _handle_milestone_rejected(event: OutboxEvent) -> None:
    payload = event.payload or {}
    contract_id = payload.get("contract_id")
    if not contract_id:
        return
    deal = _get_or_init_deal(contract_id)
    _apply_parties_and_sphere(deal, payload)
    _touch_period(deal, _parse_dt(payload.get("occurred_at")))
    deal.milestones_rejected += 1
    deal.save()

    fact = _get_or_init_milestone_fact(payload)
    if fact is not None:
        fact.rejections += 1
        fact.last_rejected_at = _parse_dt(payload.get("occurred_at"))
        # ADR-017: отклонить без пункта чек-листа нельзя, поэтому «почему»
        # у отклонения есть всегда — но событие СТАРОГО формата его не
        # несёт, и затирать уже записанную причину пустой строкой нельзя.
        reason = payload.get("checklist_item_description")
        if reason:
            fact.last_rejection_reason = reason
        fact.save()


def _is_warranty_dispute(payload: dict[str, Any]) -> bool:
    """ADR-030: гарантийные обращения — ОТДЕЛЬНАЯ метрика, рейтинг задним
    числом НЕ пересчитывают. С этапа 7 (ADR-131) гарантийная претензия
    открывает `Dispute(kind=warranty)` и публикует ТЕ ЖЕ топики
    `dispute.opened`/`dispute.resolved`, что спор по этапу — различает их
    только `payload["dispute_kind"]`. Без этой отсечки счётчики
    `disputes_opened`/`disputes_resolved` карточки молча начали бы включать
    гарантию."""
    return payload.get("dispute_kind") == "warranty"


def _handle_dispute_opened(event: OutboxEvent) -> None:
    payload = event.payload or {}
    contract_id = payload.get("contract_id")
    if not contract_id or _is_warranty_dispute(payload):
        return
    deal = _get_or_init_deal(contract_id)
    _apply_parties_and_sphere(deal, payload)
    _touch_period(deal, _parse_dt(payload.get("occurred_at")))
    deal.disputes_opened += 1
    deal.save()

    fact = _get_or_init_milestone_fact(payload)
    if fact is not None:
        fact.disputes_opened += 1
        fact.save()


def _handle_dispute_resolved(event: OutboxEvent) -> None:
    payload = event.payload or {}
    contract_id = payload.get("contract_id")
    if not contract_id or _is_warranty_dispute(payload):
        return
    deal = _get_or_init_deal(contract_id)
    _apply_parties_and_sphere(deal, payload)
    _touch_period(deal, _parse_dt(payload.get("occurred_at")))
    deal.disputes_resolved += 1
    resolution_type = payload.get("resolution_type")
    if resolution_type:
        deal.dispute_resolutions = [*deal.dispute_resolutions, resolution_type]
    deal.save()


def _handle_payment_confirmed(event: OutboxEvent) -> None:
    """`milestone.payment_confirmed` — ось ЗАКАЗЧИКА «оплачено в срок».

    Считается ТОЛЬКО подтверждение ПЛАТЕЛЬЩИКА (`side=customer`):
    подтверждение получателя говорит, что деньги дошли, а не что их вовремя
    отправили (apps.payments: `PAYER_ROLE = customer` во всех типах
    договоров каталога, включая заём). Без `payment_due_at` (события старого
    формата, договор без выставленного счёта) мерить нечего — строка этапа
    остаётся с `payment_on_time=None` и в знаменатель не идёт."""
    payload = event.payload or {}
    contract_id = payload.get("contract_id")
    if not contract_id or payload.get("side") != "customer":
        return
    due_at = _parse_dt(payload.get("payment_due_at"))
    confirmed_at = _parse_dt(payload.get("confirmed_at")) or _parse_dt(payload.get("occurred_at"))
    if due_at is None or confirmed_at is None:
        return
    deal = _get_or_init_deal(contract_id)
    _apply_parties_and_sphere(deal, payload)
    fact = _get_or_init_milestone_fact(payload)
    if fact is None:
        return
    fact.payment_due_at = due_at
    fact.payment_confirmed_at = confirmed_at
    fact.payment_on_time = confirmed_at <= due_at
    fact.save()
    recompute_deal_counters(deal)
    deal.save()


def _handle_warranty_claim_submitted(event: OutboxEvent) -> None:
    """ADR-030 + ADR-163 §6: гарантийные обращения — ОТДЕЛЬНЫЙ счётчик.
    Он не входит НИ В ОДИН знаменатель долей и ничего не пересчитывает
    задним числом: событие само несёт `affects_reputation: false`
    (apps.warranty.services), а карточка показывает лишь факт «по сделке
    была гарантийная претензия»."""
    payload = event.payload or {}
    contract_id = payload.get("contract_id")
    if not contract_id:
        return
    deal = _get_or_init_deal(contract_id)
    _apply_parties_and_sphere(deal, payload)
    deal.warranty_claims += 1
    deal.save()


_SPHERE_FALLBACK = "other"


def _record_portfolio_facts(deal: DealFact) -> None:
    sphere_code = deal.sphere_codes[0] if deal.sphere_codes else _SPHERE_FALLBACK
    completed_date = deal.completed_at.date() if deal.completed_at else None
    for profile_id in (deal.customer_profile_id, deal.contractor_profile_id):
        if not profile_id:
            continue
        profile = Profile.objects.filter(pk=profile_id).first()
        if profile is None:
            continue
        profiles_services.record_from_contract_project(
            profile,
            contract_id=deal.contract_id,
            title=deal.last_milestone_title,
            sphere=sphere_code,
            completed_at=completed_date,
        )


def _handle_contract_completed(event: OutboxEvent) -> None:
    payload = event.payload or {}
    contract_id = payload.get("contract_id")
    if not contract_id:
        return
    deal = _get_or_init_deal(contract_id)
    customer_id, contractor_id = _party_profile_ids(payload.get("parties") or {})
    if customer_id:
        deal.customer_profile_id = customer_id
    if contractor_id:
        deal.contractor_profile_id = contractor_id
    deal.contract_type_code = payload.get("contract_type_code") or ""
    deal.segment = payload.get("segment") or ""
    completed_at = _parse_dt(payload.get("completed_at"))
    deal.completed_at = completed_at
    _touch_period(deal, completed_at)
    if completed_at is not None:
        deal.period_end = completed_at
    # ADR-163 §4: объём и уровень защиты СЧИТАЕМ, но публичной карточке не
    # отдаём — только приватный `/insights` владельца. Деньги парой: сумма
    # без валюты в БД запрещена CheckConstraint'ом.
    total = payload.get("total") or {}
    amount = total.get("amount")
    currency = total.get("currency")
    if amount is not None and currency:
        deal.total_amount = Decimal(str(amount))
        deal.total_currency = currency
    deal.payment_method = payload.get("payment_method") or ""
    if payload.get("payment_protected") is not None:
        deal.payment_protected = bool(payload["payment_protected"])
    deal.outcome = DealFact.Outcome.COMPLETED
    deal.is_completed = True
    recompute_deal_counters(deal)
    deal.save()
    _record_portfolio_facts(deal)


_HANDLERS = {
    "milestone.accepted": _handle_milestone_accepted,
    "milestone.payment_confirmed": _handle_payment_confirmed,
    "warranty.claim_submitted": _handle_warranty_claim_submitted,
    "milestone.auto_accepted": _handle_milestone_accepted,
    "milestone.rejected": _handle_milestone_rejected,
    "dispute.opened": _handle_dispute_opened,
    "dispute.resolved": _handle_dispute_resolved,
    "contract.completed": _handle_contract_completed,
}


def _mark_processed(event: OutboxEvent) -> bool:
    """True — событие новое (процессить); False — уже видели, NOOP."""
    with transaction.atomic():
        _record, created = ProcessedEvent.objects.get_or_create(
            event_id=event.event_id, defaults={"topic": event.topic}
        )
    return created


def handle_event(event: OutboxEvent) -> None:
    handler = _HANDLERS.get(event.topic)
    if handler is None:
        return
    if not _mark_processed(event):
        return
    handler(event)
