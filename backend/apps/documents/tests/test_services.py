"""apps.documents — Э4.6 (docs/tasks/etap-4.md): файлы-заглушки как
доказательства формальной сдачи."""

from __future__ import annotations

import pytest

from apps.documents import selectors, services
from apps.milestones.tests._execution_helpers import (
    add_checklist_item_with_evidence,
    make_signed_contract_with_leaf,
    make_user,
)

pytestmark = pytest.mark.django_db(databases=["default", "audit"])


@pytest.fixture
def customer():
    return make_user("doc001")


@pytest.fixture
def contractor():
    return make_user("doc002")


def test_required_evidence_covered_true_when_no_items():
    assert selectors.required_evidence_covered(checklist_item_ids=[]) is True


def test_required_evidence_covered_false_without_document(customer, contractor):
    contract, milestone = make_signed_contract_with_leaf(customer=customer, contractor=contractor)
    item = add_checklist_item_with_evidence(milestone)
    assert selectors.required_evidence_covered(checklist_item_ids=[item.id]) is False


def test_required_evidence_covered_true_after_upload(customer, contractor):
    contract, milestone = make_signed_contract_with_leaf(customer=customer, contractor=contractor)
    item = add_checklist_item_with_evidence(milestone)
    services.upload_document(
        contract=contract,
        user=contractor,
        milestone=milestone,
        checklist_item=item,
        file_name="photo.jpg",
    )
    assert selectors.required_evidence_covered(checklist_item_ids=[item.id]) is True


def test_upload_document_wrong_milestone_checklist_item_is_forbidden(customer, contractor):
    contract, milestone = make_signed_contract_with_leaf(customer=customer, contractor=contractor)
    _contract2, milestone2 = make_signed_contract_with_leaf(
        customer=make_user("doc003"), contractor=make_user("doc004")
    )
    item = add_checklist_item_with_evidence(milestone2)
    with pytest.raises(services.ChecklistItemWrongMilestoneError):
        services.upload_document(
            contract=contract,
            user=contractor,
            milestone=milestone,
            checklist_item=item,
            file_name="photo.jpg",
        )
