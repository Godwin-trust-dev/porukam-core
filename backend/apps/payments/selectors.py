"""Чтение apps.payments (ADR-130). Ни одного write — материализация счетов
живёт в services.ensure_contract_payments, вызывать её обязан вызывающий
слой (api/views.py), а не селектор."""

from __future__ import annotations

from typing import Any
from uuid import UUID

from django.db.models import QuerySet
from django.shortcuts import get_object_or_404

from apps.accounts.models import User
from apps.contracts import services as contracts_services
from apps.contracts.models import Contract
from apps.deadlines import selectors as deadlines_selectors
from apps.milestones.models import Milestone

from .models import Payment
from .services import (
    PAYEE_ROLE,
    PAYER_ROLE,
    PAYMENT_DEADLINE_KIND,
    PAYMENT_DEADLINE_SUBJECT,
    side_of,
)


def get_payment_or_404(payment_id: UUID) -> Payment:
    return get_object_or_404(
        Payment.objects.select_related("contract", "milestone").prefetch_related(
            "contract__parties__profile", "contract__parties__entity"
        ),
        pk=payment_id,
    )


def list_for_contract(contract: Contract) -> QuerySet[Payment]:
    return (
        Payment.objects.filter(contract=contract)
        .select_related("milestone")
        .order_by("milestone__order", "created_at")
    )


def find_for_milestone(milestone: Milestone, *, kind: str) -> Payment | None:
    return Payment.objects.filter(milestone=milestone, kind=kind).first()


def payment_view(payment: Payment, *, user: User | None = None) -> dict[str, Any]:
    """Представление платежа для api/ (tech-spec.md §8.7 `GET /payments/{id}`
    — «статус операции + обе раскладки»; раскладок в этой волне нет,
    платформа денег не проводит и удерживать нечего — ADR-130).

    `amount` — СТРОКОЙ (CLAUDE.md). Булевы `confirmed_by_payer/payee` —
    ровно те поля, что перечисляет схема §5.2.6: наружу отдаём и их, и
    метки времени, из которых они выведены.

    `my_side`/`confirmed_by_me` считаются на бэке: фронт не должен
    повторять доменное правило «плательщик — заказчик» (тот же принцип,
    что `state` в `apps.dashboards.selectors._payment_state`).
    """
    role: str | None = None
    if user is not None:
        try:
            role = str(contracts_services.get_party_for_user(payment.contract, user).role)
        except contracts_services.NotAPartyError:
            role = None
    my_side = side_of(role) if role in (PAYER_ROLE, PAYEE_ROLE) else None
    confirmed_by_payer = payment.payer_confirmed_at is not None
    confirmed_by_payee = payment.payee_confirmed_at is not None
    confirmed_by_me = None
    if my_side == "payer":
        confirmed_by_me = confirmed_by_payer
    elif my_side == "payee":
        confirmed_by_me = confirmed_by_payee
    return {
        "id": str(payment.id),
        "contract_id": str(payment.contract_id),
        "milestone_id": str(payment.milestone_id),
        "milestone_title": payment.milestone.title,
        "kind": payment.kind,
        "method": payment.method,
        "status": payment.status,
        "amount": str(payment.amount),
        "currency": payment.currency,
        "confirmed_by_payer": confirmed_by_payer,
        "confirmed_by_payee": confirmed_by_payee,
        "payer_confirmed_at": payment.payer_confirmed_at,
        "payee_confirmed_at": payment.payee_confirmed_at,
        "cancelled_at": payment.cancelled_at,
        "cancel_reason": payment.cancel_reason,
        "overdue_at": payment.overdue_at,
        "provider": payment.provider,
        "provider_ref": payment.provider_ref,
        "my_side": my_side,
        "confirmed_by_me": confirmed_by_me,
        "created_at": payment.created_at,
    }


def reputation_payment_facts(contract: Contract) -> dict[UUID, dict[str, Any]]:
    """Узкий фасад ДЛЯ БЭКФИЛЛА репутации (ADR-163 §7): по этапу — срок
    оплаты (дедлайн категории `payment_settlement`) и момент подтверждения
    ПЛАТЕЛЬЩИКОМ. Ключ — `milestone_id`.

    Берётся именно `payer_confirmed_at`, а не `payee_confirmed_at`:
    «оплачено в срок» — про того, кто платил (`services.PAYER_ROLE`), а не
    про того, кто подтвердил получение. Фасад, а не прямое чтение
    `Payment` из apps.reputation: «где живёт срок оплаты» — знание
    apps.payments (дедлайн висит на платеже, не на этапе)."""
    facts: dict[UUID, dict[str, Any]] = {}
    for payment in list_for_contract(contract):
        if payment.milestone_id is None:
            continue
        deadline = deadlines_selectors.latest_deadline_for_subject(
            kind=PAYMENT_DEADLINE_KIND,
            subject_type=PAYMENT_DEADLINE_SUBJECT,
            subject_id=payment.id,
        )
        facts[payment.milestone_id] = {
            "due_at": deadline.deadline_at if deadline is not None else None,
            "confirmed_at": payment.payer_confirmed_at,
        }
    return facts
