"""Приёмка ЭФ.3: management-команда verify_audit_chain отвечает «цепочка
целостна, N записей» либо показывает разрыв с номером seq."""

from __future__ import annotations

import io

import pytest
from django.core.management import call_command
from django.db import connections

from services.audit_vault import api

pytestmark = pytest.mark.django_db(databases=["audit"])


def test_command_reports_intact_chain():
    for i in range(3):
        api.append(
            actor={},
            actor_role="system",
            action="a",
            target_type="t",
            target_id=str(i),
            payload={},
        )
    out = io.StringIO()
    call_command("verify_audit_chain", stdout=out)
    assert "цепочка целостна, 3 записей" in out.getvalue()


def test_command_reports_break_with_seq():
    for i in range(3):
        api.append(
            actor={},
            actor_role="system",
            action="a",
            target_type="t",
            target_id=str(i),
            payload={},
        )
    with connections["audit"].cursor() as cursor:
        cursor.execute("UPDATE audit_entry SET payload = %s WHERE seq = %s", ['{"x":1}', 2])

    out = io.StringIO()
    call_command("verify_audit_chain", stdout=out)
    assert "разрыв цепочки на seq=2" in out.getvalue()
