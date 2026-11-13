"""Read-слой apps.authority."""

from __future__ import annotations

from typing import Any
from uuid import UUID

from django.db.models import QuerySet
from django.shortcuts import get_object_or_404

from apps.accounts.models import User

from .models import ContractAssignment, Representative, SigningAuthority


def list_representatives(entity_id: Any) -> QuerySet[Representative]:
    return Representative.objects.filter(business_entity_id=entity_id).order_by("-created_at")


def get_representative_or_404(entity_id: Any, representative_id: Any) -> Representative:
    return get_object_or_404(Representative, pk=representative_id, business_entity_id=entity_id)


def list_signing_authorities(entity_id: Any) -> QuerySet[SigningAuthority]:
    return SigningAuthority.objects.filter(business_entity_id=entity_id).order_by("-created_at")


def get_signing_authority_or_404(entity_id: Any, authority_id: Any) -> SigningAuthority:
    return get_object_or_404(SigningAuthority, pk=authority_id, business_entity_id=entity_id)


def has_active_representative(user: User, entity_id: Any) -> bool:
    """apps.accounts.middleware (X-Acting-Profile, etap-3.md 3.5): профиль
    юрлица разрешён актёру, если у него есть активное представительство —
    КОНКРЕТНОЕ разрешение проверяется отдельно, на уровне операции
    (has_permission), не здесь."""
    return Representative.objects.filter(
        user=user, business_entity_id=entity_id, is_active=True
    ).exists()


def has_permission(user: User, entity_id: Any, permission: str) -> bool:
    return Representative.objects.filter(
        user=user, business_entity_id=entity_id, is_active=True, permissions__contains=[permission]
    ).exists()


def entity_ids_represented_by(user: User) -> set[UUID]:
    """Facade для apps.profiles (GET /users/me: «мои» бизнес-профили —
    claim'нутые самим пользователем ИЛИ те, где он активный представитель)."""
    return set(
        Representative.objects.filter(user=user, is_active=True).values_list(
            "business_entity_id", flat=True
        )
    )


def get_assignment(assignment_id: UUID) -> ContractAssignment | None:
    """Назначение на договор по id — для apps.evidence (ADR-053/ADR-136:
    манифест DeviceKey несёт `assignment_id`, проверка — фасадом authority,
    без импорта чужой модели)."""
    return (
        ContractAssignment.objects.filter(pk=assignment_id).select_related("representative").first()
    )
