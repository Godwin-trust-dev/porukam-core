"""Общие фабрики для тестов исполнения (Э4.6, docs/tasks/etap-4.md) — не
test_*.py (pytest не собирает как тесты, pyproject.toml `python_files`).
Переиспользует `apps.contracts.tests._signing_helpers` (тот же приём, что
`apps/contracts/tests/_signing_helpers.py` docstring — «общие мелкие
фабрики»): `make_signed_contract` уже проводит договор через Э4.2-Э4.4
полностью (draft -> under_review -> pending_signature -> signed)."""

from __future__ import annotations

from decimal import Decimal

from django.utils import timezone

from apps.accounts.models import User
from apps.contracts.models import Contract
from apps.contracts.tests._signing_helpers import (
    make_frozen_contract,
    make_signed_contract,
    make_under_review_contract,
    make_user,
    route_both_sides,
    sign_both,
)
from apps.milestones.models import ChecklistItem, ContractMaterial, Milestone

__all__ = [
    "make_frozen_contract",
    "make_signed_contract",
    "make_under_review_contract",
    "make_user",
    "route_both_sides",
    "sign_both",
]


def make_signed_contract_with_leaf(
    *,
    customer: User,
    contractor: User,
    payment_method: str = Contract.PaymentMethod.CASH,
    payment_order: str | None = None,
) -> tuple[Contract, Milestone]:
    """Подписанный договор с ОДНИМ этапом-листом (10000.00 RUB) — стартовая
    точка для гейта/сдачи/приёмки. `payment_order=None` — «не менять»
    (`make_signed_contract` ставит `after_acceptance`, ADR-151); передать
    `before_start` — предоплатный сценарий ADR-155."""
    contract = make_signed_contract(customer=customer, contractor=contractor)
    contract.payment_method = payment_method
    update_fields = ["payment_method"]
    if payment_order is not None:
        contract.payment_order = payment_order
        update_fields.append("payment_order")
    contract.save(update_fields=update_fields)
    milestone = contract.milestones.get()
    return contract, milestone


def add_customer_material(milestone: Milestone, *, received: bool = False) -> ContractMaterial:
    """ADR-155: `received=True` в фикстуре — материал, у которого обе
    стороны уже отметились (штатный, а не односторонний путь), поэтому
    метка передачи ставится вместе с получением."""
    from apps.catalog.models import MaterialCatalogItem

    catalog_item = MaterialCatalogItem.objects.filter(is_active=True).first()
    assert catalog_item is not None, "фикстуры каталога материалов должны быть засеяны"
    now = timezone.now()
    return ContractMaterial.objects.create(
        milestone=milestone,
        catalog_item=catalog_item,
        description="Плитка керамическая",
        quantity=Decimal("10"),
        unit="м2",
        unit_price=Decimal("500.00"),
        unit_price_currency="RUB",
        source=ContractMaterial.Source.CUSTOMER,
        handed_over_at=now if received else None,
        received=received,
        received_at=now if received else None,
    )


def add_checklist_item_with_evidence(milestone: Milestone) -> ChecklistItem:
    return ChecklistItem.objects.create(
        milestone=milestone,
        description="Плитка уложена ровно",
        measurable_criterion="Отклонение <= 2мм на 2м",
        required_evidence=["photo"],
    )
