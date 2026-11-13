"""Read-слой apps.warranty."""

from __future__ import annotations

from uuid import UUID

from django.db.models import QuerySet
from django.shortcuts import get_object_or_404

from apps.accounts.models import User
from apps.contracts import selectors as contracts_selectors
from apps.contracts.models import Contract

from .models import WarrantyClaim


def list_for_contract(contract: Contract) -> QuerySet[WarrantyClaim]:
    """GET /contracts/{id}/warranty-claims (tech-spec.md §8.8)."""
    return WarrantyClaim.objects.filter(contract=contract).order_by("-submitted_at")


def list_for_user(user: User) -> QuerySet[WarrantyClaim]:
    owned = contracts_selectors.user_owned_profile_ids(user)
    return (
        WarrantyClaim.objects.filter(contract__parties__profile_id__in=owned)
        .select_related("contract")
        .distinct()
        .order_by("-submitted_at")
    )


def get_by_dispute(dispute_id: UUID) -> WarrantyClaim | None:
    """Заявка, породившая этот спор (`Dispute(kind=warranty)`), — вход для
    подписчика на `dispute.resolved`."""
    return WarrantyClaim.objects.filter(dispute_id=dispute_id).select_related("contract").first()


def get_claim_or_404(claim_id: UUID) -> WarrantyClaim:
    return get_object_or_404(WarrantyClaim.objects.select_related("contract"), pk=claim_id)


def get_claim(claim_id: UUID | str) -> WarrantyClaim | None:
    """Мягкий вариант для подписчиков (свип дедлайна, ADR-133) — без Http404
    из сервиса, где HTTP-контекста нет."""
    return WarrantyClaim.objects.filter(pk=claim_id).select_related("contract").first()
