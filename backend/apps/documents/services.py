"""Use cases apps.documents — Э4.6 (docs/tasks/etap-4.md): загрузка файлов-
заглушек как доказательств формальной сдачи этапа. Полноценная загрузка байт,
шифрование, DeviceKey — этап 6/ГВ.3 (evidence ingest, CLAUDE.md: периферийные
сервисы — отдельные процессы поверх общего кодбейза)."""

from __future__ import annotations

from django.db import transaction

from apps.accounts.models import User
from apps.contracts.models import Contract
from apps.milestones.models import ChecklistItem, Milestone

from .models import Document


class ChecklistItemWrongMilestoneError(ValueError):
    """`checklist_item` указывает на пункт другого этапа, не переданного
    `milestone` — доказательство обязано быть привязано непротиворечиво."""


@transaction.atomic
def upload_document(
    *,
    contract: Contract,
    user: User,
    milestone: Milestone | None = None,
    checklist_item: ChecklistItem | None = None,
    file_name: str,
    file_hash: str = "",
    kind: str = Document.Kind.EVIDENCE,
) -> Document:
    if (
        checklist_item is not None
        and milestone is not None
        and checklist_item.milestone_id != milestone.id
    ):
        raise ChecklistItemWrongMilestoneError(
            f"пункт чек-листа {checklist_item.id} принадлежит другому этапу, не {milestone.id}"
        )
    return Document.objects.create(
        contract=contract,
        milestone=milestone,
        checklist_item=checklist_item,
        kind=kind,
        file_name=file_name,
        file_hash=file_hash,
        uploaded_by=user,
    )
