"""Приёмка ЭФ.3 (docs/tasks/fundament.md): цепочка сходится на 1000
записей; ручная порча строки в БД Vault -> verify_chain находит разрыв и
указывает seq; идемпотентность append() по source_event_id; read() —
заглушка авторизации по служебной роли."""

from __future__ import annotations

import uuid

import pytest
from django.db import connections

from services.audit_vault import api
from services.audit_vault.models import AuditEntry

pytestmark = pytest.mark.django_db(databases=["audit"])


def _append(n: int) -> None:
    for i in range(n):
        api.append(
            actor={"user_id": str(i)},
            actor_role="user",
            action="test.event",
            target_type="thing",
            target_id=str(i),
            payload={"i": i},
        )


def test_append_chains_prev_hash_to_previous_this_hash():
    first = api.append(
        actor={}, actor_role="system", action="a", target_type="t", target_id="1", payload={}
    )
    second = api.append(
        actor={}, actor_role="system", action="b", target_type="t", target_id="2", payload={}
    )
    assert first.seq == 1
    assert second.seq == 2
    assert second.prev_hash == first.this_hash
    assert first.this_hash != second.this_hash


def test_append_is_idempotent_by_source_event_id():
    event_id = uuid.uuid4()
    first = api.append(
        actor={},
        actor_role="system",
        action="a",
        target_type="t",
        target_id="1",
        payload={},
        source_event_id=event_id,
    )
    second = api.append(
        actor={},
        actor_role="system",
        action="a",
        target_type="t",
        target_id="1",
        payload={},
        source_event_id=event_id,
    )
    assert first.seq == second.seq
    assert AuditEntry.objects.count() == 1


def test_chain_converges_for_1000_entries():
    _append(1000)
    result = api.verify_chain()
    assert result.ok is True
    assert result.entries_checked == 1000
    assert result.first_broken_seq is None


def test_manual_row_corruption_is_detected_with_seq():
    _append(10)
    corrupted_seq = 5
    with connections["audit"].cursor() as cursor:
        cursor.execute(
            "UPDATE audit_entry SET payload = %s WHERE seq = %s",
            ['{"tampered": true}', corrupted_seq],
        )

    result = api.verify_chain()
    assert result.ok is False
    assert result.first_broken_seq == corrupted_seq


def test_verify_chain_over_range_anchors_on_previous_entry():
    _append(10)
    result = api.verify_chain(seq_from=6, seq_to=10)
    assert result.ok is True
    assert result.entries_checked == 5


def test_read_denies_role_outside_allowlist():
    api.append(
        actor={}, actor_role="system", action="a", target_type="t", target_id="1", payload={}
    )
    with pytest.raises(api.VaultReadPermissionError):
        api.read(actor_role="contractor")


def test_read_allows_staff_role_and_applies_filters():
    api.append(
        actor={}, actor_role="system", action="a", target_type="t", target_id="1", payload={}
    )
    api.append(
        actor={}, actor_role="system", action="b", target_type="t", target_id="2", payload={}
    )
    entries = api.read(actor_role="support", target_id="2")
    assert [e.target_id for e in entries] == ["2"]
