"""Миграция authority 0002 (employee -> member, ADR-203) — на реальных строках, живой PostgreSQL."""

from __future__ import annotations

from collections.abc import Iterator

import pytest
from django.db import connection
from django.db.migrations.executor import MigrationExecutor

from apps.accounts.models import User
from apps.entities.models import BusinessEntity

pytestmark = pytest.mark.django_db(transaction=True)

BEFORE = [("authority", "0001_initial")]
AFTER = [("authority", "0002_role_employee_to_member")]


def _migrate(targets: list[tuple[str, str]]):
    executor = MigrationExecutor(connection)
    executor.loader.build_graph()
    executor.migrate(targets)
    # Состояние: целевая миграция authority + листья остальных приложений
    # (иначе accounts.User, на который ссылается 0001, не попадает в граф состояния).
    others = [n for n in executor.loader.graph.leaf_nodes() if n[0] != "authority"]
    return executor.loader.project_state(targets + others).apps


@pytest.fixture(autouse=True)
def _restore_latest() -> Iterator[None]:
    yield
    # Соседние тесты ожидают схему на последней миграции.
    executor = MigrationExecutor(connection)
    executor.migrate(executor.loader.graph.leaf_nodes())


def _roles(apps) -> dict[str, str]:
    Representative = apps.get_model("authority", "Representative")
    return {r.user_id: r.role for r in Representative.objects.all()}


def test_employee_becomes_member_others_untouched_and_reverse() -> None:
    owner = User.objects.create(trust_id="mig-owner", phone="+79990910000")
    entity = BusinessEntity.objects.create(
        country_of_registration="RU",
        local_form_code="ru_ooo",
        name="ООО Миграция",
        created_by=owner,
    )
    users = {
        role: User.objects.create(trust_id=f"mig-{role}", phone=f"+7999091{i:04d}")
        for i, role in enumerate(["employee", "administrator", "manager", "member"], start=1)
    }

    apps = _migrate(BEFORE)
    Representative = apps.get_model("authority", "Representative")
    for role, user in users.items():
        Representative.objects.create(user_id=user.id, business_entity_id=entity.id, role=role)

    apps = _migrate(AFTER)
    assert _roles(apps) == {
        users["employee"].id: "member",
        users["administrator"].id: "administrator",
        users["manager"].id: "manager",
        users["member"].id: "member",
    }

    apps = _migrate(BEFORE)
    # Обратная функция возвращает ВСЕХ member в employee (исходное различие не восстановимо).
    assert _roles(apps) == {
        users["employee"].id: "employee",
        users["administrator"].id: "administrator",
        users["manager"].id: "manager",
        users["member"].id: "employee",
    }
