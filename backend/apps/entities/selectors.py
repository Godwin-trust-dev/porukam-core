"""Read-слой apps.entities."""

from __future__ import annotations

from typing import Any
from uuid import UUID

from django.db.models import QuerySet
from django.shortcuts import get_object_or_404

from .models import BusinessEntity, OwnershipEpoch


def get_business_entity_or_404(entity_id: UUID) -> BusinessEntity:
    return get_object_or_404(BusinessEntity, pk=entity_id)


def list_epochs(entity: BusinessEntity) -> QuerySet[OwnershipEpoch]:
    return entity.ownership_epochs.all()


def list_claim_methods() -> list[dict[str, Any]]:
    """GET /business-entities/{id}/claim-methods (etap-3.md 3.4): все
    способы из enum, реализованные — с available=True, остальные — «скоро»."""
    return [
        {
            "method": method.value,
            "title": method.label,
            "available": method in BusinessEntity.IMPLEMENTED_CLAIM_METHODS,
        }
        for method in BusinessEntity.ClaimMethod
    ]
