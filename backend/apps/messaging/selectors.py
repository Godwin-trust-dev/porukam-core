"""Read-слой apps.messaging (ADR-112). Чужой договор = 404 (приватность не
раскрывает существование, CLAUDE.md web §2 п.6 — та же семантика на бэке).
Доступ к договору и сторонам — только через фасад apps.contracts.selectors."""

from __future__ import annotations

from typing import Any
from uuid import UUID

from django.db.models import QuerySet
from django.http import Http404

from apps.accounts.models import User
from apps.contracts import selectors as contracts_selectors

from .models import Message


def get_contract_for_party_or_404(contract_id: UUID, *, user: User) -> Any:
    contract = contracts_selectors.get_contract(contract_id)
    if contract is None:
        raise Http404
    owned = contracts_selectors.user_owned_profile_ids(user)
    if not any(p.profile_id in owned for p in contract.parties.all()):
        raise Http404
    return contract


def list_messages(contract: Any) -> QuerySet[Message]:
    return Message.objects.filter(contract=contract).order_by("created_at")


def unread_count(contract: Any, *, owned_profile_ids: set[Any]) -> int:
    """Непрочитанные МНОЙ: чужие сообщения без read_at."""
    return (
        Message.objects.filter(contract=contract, read_at__isnull=True)
        .exclude(sender_profile_id__in=owned_profile_ids)
        .count()
    )


def has_unread_from_sender(contract: Any, *, sender_profile_ids: set[Any]) -> bool:
    """Есть ли уже непрочитанные сообщения ОТ этих профилей — анти-шторм
    уведомлений (ADR-112 §5): контрагента зовут один раз на серию."""
    return Message.objects.filter(
        contract=contract, read_at__isnull=True, sender_profile_id__in=sender_profile_ids
    ).exists()


def list_threads(user: User) -> list[dict[str, Any]]:
    """`GET /v1/messages/threads` — диалоги пользователя: договоры с хотя бы
    одним сообщением, последнее сообщение + непрочитанное, свежие сверху."""
    owned = contracts_selectors.user_owned_profile_ids(user)
    contract_ids = set(
        Message.objects.filter(contract__parties__profile_id__in=owned)
        .values_list("contract_id", flat=True)
        .distinct()
    )
    if not contract_ids:
        return []
    contracts = {
        contract.id: contract
        for contract in contracts_selectors.list_contracts_by_ids(contract_ids)
    }
    threads: list[dict[str, Any]] = []
    for contract_id in contract_ids:
        contract = contracts[contract_id]
        last = Message.objects.filter(contract=contract).order_by("-created_at").first()
        if last is None:  # гонка с каскадным удалением черновика
            continue
        other = contracts_selectors.resolve_counterparty(contract, user)
        threads.append(
            {
                "contract_id": str(contract.id),
                "contract_title": contract.title,
                "counterparty_profile_id": str(other.profile_id),
                "last_message": {
                    "body": last.body,
                    "created_at": last.created_at,
                    "sender_profile_id": str(last.sender_profile_id),
                },
                "unread_count": unread_count(contract, owned_profile_ids=owned),
            }
        )
    threads.sort(key=lambda t: t["last_message"]["created_at"], reverse=True)
    return threads
