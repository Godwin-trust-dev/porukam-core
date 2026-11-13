"""Общие фабрики для тестов этапа 7 (ADR-131) — не `test_*.py` (pytest не
собирает как тесты, pyproject.toml `python_files`). Переиспользуют
`apps.milestones.tests._execution_helpers`: единственная точка, где заводится
подписанный договор с листом."""

from __future__ import annotations

from apps.contracts.models import Contract, ContractParty
from apps.disputes.models import Dispute
from apps.evidence import services as evidence_services
from apps.milestones import services as milestones_services
from apps.milestones.tests._execution_helpers import (
    add_checklist_item_with_evidence,
    make_signed_contract_with_leaf,
    make_user,
)
from common import relay

__all__ = [
    "make_user",
    "make_signed_contract_with_leaf",
    "submit_milestone_with_evidence",
    "open_milestone_dispute",
    "make_warranty_contract",
]

_ROLE = ContractParty.Role


def submit_milestone_with_evidence(contract, milestone, *, customer, contractor):
    """Гейт -> чек-лист -> доказательство -> формальная сдача. Возвращает
    пункт чек-листа (он нужен для отклонения приёмки, ADR-017)."""
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
    return item


def open_milestone_dispute(contract, milestone, *, customer, contractor):
    """Полный ЛЕГИТИМНЫЙ путь в спор: сдача -> отклонение приёмки с пунктом
    чек-листа и доказательством -> подписчик `apps.disputes.handlers`
    открывает Dispute (`relay.deliver_due_events` прогоняет outbox)."""
    item = submit_milestone_with_evidence(
        contract, milestone, customer=customer, contractor=contractor
    )
    milestones_services.reject_milestone(
        milestone, user=customer, checklist_item_id=item.id, evidence=["photo-defect.jpg"]
    )
    # Две волны: первая доставляет `milestone.rejected` (спор открывается),
    # вторая — рождённый им `dispute.opened`, который и РАЗМЕЩАЕТ уведомление
    # в ЛК, то есть якорит окно ответа (ADR-057). Реле берёт фиксированный
    # срез due-событий ДО обработки (common/relay.py).
    relay.deliver_due_events()
    relay.deliver_due_events()
    milestone.refresh_from_db()
    return Dispute.objects.select_related("contract", "milestone").get(milestone=milestone)


def make_warranty_contract(*, customer, contractor):
    """Договор, доведённый до `execution_status=warranty`: сдача -> приёмка ->
    двустороннее подтверждение оплаты последнего листа -> `complete_execution`
    (`in_progress -> completed -> warranty`)."""
    contract, milestone = make_signed_contract_with_leaf(customer=customer, contractor=contractor)
    submit_milestone_with_evidence(contract, milestone, customer=customer, contractor=contractor)
    milestones_services.accept_milestone(milestone, user=customer)
    milestones_services.confirm_payment(milestone, user=customer, side=_ROLE.CUSTOMER)
    milestones_services.confirm_payment(milestone, user=contractor, side=_ROLE.CONTRACTOR)
    contract.refresh_from_db()
    assert contract.execution_status == Contract.ExecutionStatus.WARRANTY
    return contract, milestone
