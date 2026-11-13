from __future__ import annotations

import pytest

from services.audit_vault import api, tasks
from services.audit_vault.models import ChainVerificationRun

pytestmark = pytest.mark.django_db(databases=["default", "audit"])


def test_daily_checkpoint_records_heartbeat():
    from common.models import TaskHeartbeat

    tasks.daily_checkpoint()

    assert TaskHeartbeat.objects.filter(name="audit_vault_daily_checkpoint").exists()


def test_export_chain_verification_records_run_and_heartbeat():
    from common.models import TaskHeartbeat

    api.append(
        actor={}, actor_role="system", action="a", target_type="t", target_id="1", payload={}
    )

    ok = tasks.export_chain_verification()

    assert ok is True
    assert ChainVerificationRun.objects.count() == 1
    assert TaskHeartbeat.objects.filter(name="audit_vault_chain_verification").exists()
