"""docs/tasks/fundament-2.md ЭФ.6 п.3: периодический экспорт результата
verify_chain() — chain_health.record_verification_run()."""

from __future__ import annotations

import pytest

from services.audit_vault import api, chain_health
from services.audit_vault.models import ChainVerificationRun

pytestmark = pytest.mark.django_db(databases=["audit"])


def test_records_ok_run_on_empty_chain():
    run = chain_health.record_verification_run()

    assert run.ok is True
    assert run.entries_checked == 0
    assert run.first_broken_seq is None
    assert ChainVerificationRun.objects.count() == 1


def test_records_ok_run_on_intact_chain():
    api.append(
        actor={}, actor_role="system", action="a", target_type="t", target_id="1", payload={}
    )
    api.append(
        actor={}, actor_role="system", action="b", target_type="t", target_id="2", payload={}
    )

    run = chain_health.record_verification_run()

    assert run.ok is True
    assert run.entries_checked == 2


def test_records_broken_run_when_chain_tampered():
    entry = api.append(
        actor={}, actor_role="system", action="a", target_type="t", target_id="1", payload={}
    )
    entry.payload = {"tampered": True}
    entry.save(update_fields=["payload"])

    run = chain_health.record_verification_run()

    assert run.ok is False
    assert run.first_broken_seq == entry.seq
