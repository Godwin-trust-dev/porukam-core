"""apps.milestones.models — Э4.3 (docs/tasks/etap-4.md): CheckConstraint'ы и
БД-триггер `milestone_amount_guard` (миграция 0002) — на живом PostgreSQL
(CLAUDE.md: БД-инварианты не на sqlite)."""

from __future__ import annotations

from decimal import Decimal

import pytest
from django.db import IntegrityError
from django.utils import timezone

from apps.catalog.models import MaterialCatalogItem
from apps.milestones.models import ChecklistItem, ContractMaterial, Milestone

from ._helpers import make_contract, make_user

pytestmark = pytest.mark.django_db


@pytest.fixture
def contract():
    customer = make_user("m001")
    contractor = make_user("m002")
    return make_contract(customer=customer, contractor=contractor)


def test_amount_and_currency_must_be_set_together(contract):
    with pytest.raises(IntegrityError):
        Milestone.objects.create(contract=contract, title="x", amount=Decimal("10.00"))


def test_amount_without_children_is_allowed(contract):
    m = Milestone.objects.create(
        contract=contract, title="leaf", amount=Decimal("10.00"), amount_currency="RUB"
    )
    assert m.amount == Decimal("10.00")


def test_trigger_forbids_amount_on_node_with_children(contract):
    branch = Milestone.objects.create(contract=contract, title="branch")
    Milestone.objects.create(contract=contract, parent=branch, title="child")
    branch.amount = Decimal("5.00")
    branch.amount_currency = "RUB"
    with pytest.raises(IntegrityError, match="milestone_amount_guard"):
        branch.save(update_fields=["amount", "amount_currency"])


def test_trigger_forbids_child_under_leaf_with_amount(contract):
    leaf = Milestone.objects.create(
        contract=contract, title="leaf", amount=Decimal("10.00"), amount_currency="RUB"
    )
    with pytest.raises(IntegrityError, match="milestone_amount_guard"):
        Milestone.objects.create(contract=contract, parent=leaf, title="child")


def test_trigger_forbids_child_under_accepted_node(contract):
    branch = Milestone.objects.create(contract=contract, title="branch")
    branch.accepted_at = timezone.now()
    branch.save(update_fields=["accepted_at"])
    with pytest.raises(IntegrityError, match="milestone_amount_guard"):
        Milestone.objects.create(contract=contract, parent=branch, title="child")


def test_material_price_rule_requires_positive_price_for_contractor_source(contract):
    milestone = Milestone.objects.create(
        contract=contract, title="leaf", amount=Decimal("10.00"), amount_currency="RUB"
    )
    catalog_item = MaterialCatalogItem.objects.get(code="other_renovation")
    with pytest.raises(IntegrityError):
        ContractMaterial.objects.create(
            milestone=milestone,
            catalog_item=catalog_item,
            description="material",
            unit_price=Decimal("0.00"),
            unit_price_currency="RUB",
            source=ContractMaterial.Source.CONTRACTOR,
        )


def test_material_price_rule_allows_zero_price_for_customer_source(contract):
    milestone = Milestone.objects.create(
        contract=contract, title="leaf", amount=Decimal("10.00"), amount_currency="RUB"
    )
    catalog_item = MaterialCatalogItem.objects.get(code="other_renovation")
    material = ContractMaterial.objects.create(
        milestone=milestone,
        catalog_item=catalog_item,
        description="material",
        unit_price=Decimal("0.00"),
        unit_price_currency="RUB",
        source=ContractMaterial.Source.CUSTOMER,
    )
    assert material.unit_price == Decimal("0.00")


def test_checklist_item_str(contract):
    milestone = Milestone.objects.create(
        contract=contract, title="leaf", amount=Decimal("10.00"), amount_currency="RUB"
    )
    item = ChecklistItem.objects.create(
        milestone=milestone, description="d" * 100, measurable_criterion="c"
    )
    assert len(str(item)) == 60
