"""ADR-155, бэкфилл миграции
`apps.milestones.migrations.0009_material_two_sided_handover`.

До ADR-155 у материала был ОДИН флаг `received`, который ставила любая
сторона. Бэкфилл проставляет таким строкам «передано» ровно там, где есть
чем: `handed_over_at = received_at`. У строк без `received_at` метка
остаётся пустой — выдумывать дату факта нельзя, а гейт этапа её и не читает
(`_materials_ready` смотрит на `received`).

К моменту прогона миграция уже применена к тестовой БД, но применена «в
вакууме»: строк материалов в графе миграций не существует. Чтобы проверить
поведение НА ДАННЫХ (как будет на проде), тест создаёт «старые» строки и
вызывает функцию миграции НАПРЯМУЮ — ту же, что выполнит `manage.py
migrate`, не копию логики (приём `test_sphere_dedupe_migration`).
"""

from __future__ import annotations

import importlib
from datetime import timedelta
from decimal import Decimal

import pytest
from django.apps import apps as live_apps
from django.utils import timezone

from apps.catalog.models import MaterialCatalogItem
from apps.milestones.models import ContractMaterial, Milestone

from ._helpers import make_contract, make_user

pytestmark = pytest.mark.django_db

_migration = importlib.import_module("apps.milestones.migrations.0009_material_two_sided_handover")


def _leaf(customer, contractor) -> Milestone:
    contract = make_contract(customer=customer, contractor=contractor)
    return Milestone.objects.create(
        contract=contract,
        title="Этап",
        amount=Decimal("1000.00"),
        amount_currency="RUB",
    )


def _legacy_material(milestone: Milestone, *, received: bool, received_at) -> ContractMaterial:
    catalog_item = MaterialCatalogItem.objects.filter(is_active=True).first()
    assert catalog_item is not None
    return ContractMaterial.objects.create(
        milestone=milestone,
        catalog_item=catalog_item,
        description="Плитка со старой строки",
        quantity=Decimal("1"),
        unit_price=Decimal("0"),
        unit_price_currency="RUB",
        source=ContractMaterial.Source.CUSTOMER,
        received=received,
        received_at=received_at,
    )


def test_backfill_marks_legacy_received_materials_as_handed_over():
    milestone = _leaf(make_user("m101"), make_user("m102"))
    received_at = timezone.now() - timedelta(days=5)
    material = _legacy_material(milestone, received=True, received_at=received_at)

    _migration.backfill_handed_over(live_apps, None)

    material.refresh_from_db()
    assert material.handed_over_at == received_at


def test_backfill_leaves_received_without_timestamp_empty():
    """Метки получения нет — выдумывать дату передачи нечем и незачем."""
    milestone = _leaf(make_user("m105"), make_user("m106"))
    material = _legacy_material(milestone, received=True, received_at=None)

    _migration.backfill_handed_over(live_apps, None)

    material.refresh_from_db()
    assert material.handed_over_at is None
    assert material.received is True


def test_backfill_leaves_unreceived_materials_untouched():
    milestone = _leaf(make_user("m103"), make_user("m104"))
    material = _legacy_material(milestone, received=False, received_at=None)

    _migration.backfill_handed_over(live_apps, None)

    material.refresh_from_db()
    assert material.handed_over_at is None
    assert material.received is False
