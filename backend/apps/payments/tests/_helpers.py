"""Фабрики для тестов apps.payments (не test_*.py — pytest их не собирает,
pyproject.toml `python_files`).

Переиспользуют `apps.milestones.tests._execution_helpers`: доводить договор
от черновика до подписи и лист до `accepted` заново значило бы держать
вторую копию сценария Э4.2-Э4.6, которая разойдётся с оригиналом при первой
же правке контура исполнения.
"""

from __future__ import annotations

from apps.accounts.models import User
from apps.contracts.models import Contract
from apps.evidence import services as evidence_services
from apps.milestones import services as milestones_services
from apps.milestones.models import Milestone
from apps.milestones.tests._execution_helpers import (
    add_checklist_item_with_evidence,
    make_signed_contract_with_leaf,
    make_user,
)

__all__ = [
    "accept_leaf",
    "make_signed_contract_with_leaf",
    "make_user",
]


def accept_leaf(
    contract: Contract, milestone: Milestone, *, customer: User, contractor: User
) -> Milestone:
    """Провести лист до `accepted` — состояние, в котором домен выставляет
    постоплату."""
    milestones_services.start_milestone(milestone, user=customer)
    item = add_checklist_item_with_evidence(milestone)
    evidence_services.upload_evidence(
        contract,
        user=contractor,
        content=b"stub-photo-bytes",
        file_name="photo.jpg",
        mime_type="image/jpeg",
        milestone_id=milestone.id,
        checklist_item_id=item.id,
    )
    milestones_services.submit_milestone(milestone, user=contractor)
    milestone.refresh_from_db()
    milestones_services.accept_milestone(milestone, user=customer)
    milestone.refresh_from_db()
    return milestone
