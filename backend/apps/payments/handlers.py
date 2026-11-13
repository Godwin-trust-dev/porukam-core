"""Подписчики apps.payments на доменные события (settings.OUTBOX_SUBSCRIBERS,
ADR-130).

Счёт выставляет СОБЫТИЕ, а не вызывающий код смежного приложения: обратный
импорт (`apps.milestones -> apps.payments`) запрещён транзитивным контрактом
import-linter (см. докстринг services.py), поэтому «этап принят -> выставить
постоплату» может пройти только через outbox — тем же приёмом, каким
`apps.disputes` открывает спор на `milestone.rejected`.

Идемпотентность (обязательна: реле at-least-once НА УРОВНЕ СОБЫТИЯ, ADR-064)
здесь не требует своей таблицы обработанных событий, как у
`apps.reputation.subscriber`: единственный эффект — `create_payment`, а он
идемпотентен ограничением БД `UNIQUE (milestone, kind)`.
"""

from __future__ import annotations

import logging
from uuid import UUID

from apps.contracts.models import Contract
from apps.milestones.models import Milestone
from common.models import OutboxEvent

from . import services
from .models import Payment
from .providers import PaymentProviderNotConfiguredError

logger = logging.getLogger(__name__)

_ACCEPTED_TOPICS = frozenset({"milestone.accepted", "milestone.auto_accepted"})


def _as_uuid(value: object) -> UUID | None:
    if not value:
        return None
    try:
        return UUID(str(value))
    except (ValueError, AttributeError, TypeError):
        return None


def handle_event(event: OutboxEvent) -> None:
    """`contract.signed` -> счета по всем денежным листьям, если порядок
    оплаты `before_start` (условие гейта §6.3, ADR-155);
    `milestone.accepted`/`auto_accepted` -> оплата принятого листа."""
    if event.topic == "contract.signed":
        _handle_contract_signed(event)
    elif event.topic in _ACCEPTED_TOPICS:
        _handle_milestone_accepted(event)


def _handle_contract_signed(event: OutboxEvent) -> None:
    contract_id = _as_uuid((event.subject or {}).get("id")) or _as_uuid(
        (event.payload or {}).get("contract_id")
    )
    if contract_id is None:
        return
    contract = Contract.objects.filter(pk=contract_id).first()
    if contract is None:
        return
    services.ensure_contract_payments(contract)


def _handle_milestone_accepted(event: OutboxEvent) -> None:
    milestone_id = _as_uuid((event.subject or {}).get("id")) or _as_uuid(
        (event.payload or {}).get("milestone_id")
    )
    if milestone_id is None:
        return
    milestone = Milestone.objects.select_related("contract").filter(pk=milestone_id).first()
    if milestone is None or milestone.amount is None:
        return
    try:
        services.create_payment(milestone, kind=Payment.Kind.POSTPAYMENT)
    except PaymentProviderNotConfiguredError:
        # direct_platform/hold: партнёра нет, счёт не выставляется — это
        # НЕ сбой доставки (иначе событие ушло бы в вечный ретрай реле и
        # заблокировало бы остальных подписчиков темы).
        logger.info(
            "payments: постоплата по этапу %s не выставлена — способ расчёта требует партнёра",
            milestone_id,
        )
    except services.MilestoneNotPayableError:
        logger.info("payments: этап %s не денежный лист — счёт не выставляется", milestone_id)


def handle_deadline_fired(event: OutboxEvent) -> None:
    """`domain_deadline.fired` c `kind=payment_settlement` -> `payment.overdue`
    (CLAUDE.md: доменные дедлайны — строки в БД + свип, не отложенные
    задачи). Чужие категории игнорируются молча — на топик подписаны
    обработчики нескольких приложений."""
    payload = event.payload or {}
    if payload.get("kind") != services.PAYMENT_DEADLINE_KIND:
        return
    payment_id = _as_uuid((event.subject or {}).get("id"))
    if payment_id is None:
        return
    payment = Payment.objects.select_related("contract", "milestone").filter(pk=payment_id).first()
    if payment is None:
        return
    services.mark_overdue(payment)
