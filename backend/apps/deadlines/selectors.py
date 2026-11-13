"""Read-слой apps.deadlines."""

from __future__ import annotations

from datetime import timedelta
from uuid import UUID

from django.db.models import QuerySet
from django.shortcuts import get_object_or_404

from .models import DeadlineKindConfig, DomainDeadline


def get_kind_duration(kind: str) -> timedelta | None:
    """Длительность категории из `DeadlineKindConfig` — для вызывающих
    сторон, которым нужен сам параметр, а не строка дедлайна (ADR-136:
    окно выгрузки доказательств `evidence_upload_window` — параметр
    категории ADR-053, по нему считается `lateness`, дедлайна не заводится).
    `None` — категория не засеяна."""
    return DeadlineKindConfig.objects.filter(kind=kind).values_list("duration", flat=True).first()


def get_deadline_or_404(deadline_id: UUID) -> DomainDeadline:
    return get_object_or_404(DomainDeadline, pk=deadline_id)


def get_deadline(deadline_id: UUID) -> DomainDeadline | None:
    """Мягкий вариант `get_deadline_or_404` — для доменных вызывающих сторон
    (ADR-131: `apps.disputes` хранит `DisputeWindow.deadline_id` ПО ЗНАЧЕНИЮ,
    без FK, и обязана переживать отсутствие строки, а не бросать Http404 из
    сервиса, где HTTP-контекста нет)."""
    return DomainDeadline.objects.filter(pk=deadline_id).first()


def list_active_for_subject(*, subject_type: str, subject_id: UUID) -> QuerySet[DomainDeadline]:
    """Активные (ещё не сработавшие) дедлайны субъекта — для экранов
    приёмки/спора (`GET /milestones/{id}/acceptance`, tech-spec.md §7)."""
    return DomainDeadline.objects.filter(
        subject_type=subject_type, subject_id=subject_id, fired_at__isnull=True
    )


def latest_deadline_for_subject(
    *, kind: str, subject_type: str, subject_id: UUID
) -> DomainDeadline | None:
    """Последний дедлайн категории у субъекта — ВКЛЮЧАЯ уже сработавший.
    Отличие от `list_active_for_subject` принципиально: срок оплаты нужен
    как раз тогда, когда его уже пропустили (ADR-163: «оплачено в срок» —
    сравнение момента подтверждения с `deadline_at`, и просроченная строка
    из выборки выпадать не должна)."""
    return (
        DomainDeadline.objects.filter(kind=kind, subject_type=subject_type, subject_id=subject_id)
        .order_by("-anchor_at", "-id")
        .first()
    )
