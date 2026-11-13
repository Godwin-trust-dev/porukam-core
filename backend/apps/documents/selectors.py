"""Read-слой apps.documents."""

from __future__ import annotations

from uuid import UUID

from django.db.models import QuerySet
from django.shortcuts import get_object_or_404

from .models import Document


def get_document_or_404(document_id: UUID) -> Document:
    return get_object_or_404(
        Document.objects.select_related("contract", "milestone"), pk=document_id
    )


def list_for_milestone(milestone_id: UUID) -> QuerySet[Document]:
    return Document.objects.filter(milestone_id=milestone_id)


def list_for_checklist_item(checklist_item_id: UUID) -> QuerySet[Document]:
    return Document.objects.filter(checklist_item_id=checklist_item_id)


def required_evidence_covered(*, checklist_item_ids: list[UUID]) -> bool:
    """Формальная сдача (etap-4.md Э4.6, tech-spec.md §8.5 `POST .../submit`):
    «все required_evidence чек-листа покрыты». Покрытие — минимальная
    заглушка (полный evidence-контур, где required_evidence сверяется
    ПОЭЛЕМЕНТНО с типом доказательства, — этап 6/ГВ.3): пункт с непустым
    `required_evidence` считается покрытым, если к нему приложен хотя бы
    один `Document`. Пункты без `required_evidence` (пустой список) покрытия
    не требуют — им нечего подтверждать файлом."""
    if not checklist_item_ids:
        return True
    documented_ids = set(
        Document.objects.filter(checklist_item_id__in=checklist_item_ids)
        .values_list("checklist_item_id", flat=True)
        .distinct()
    )
    return set(checklist_item_ids) <= documented_ids
