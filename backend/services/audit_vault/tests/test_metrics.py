from __future__ import annotations

import pytest

from services.audit_vault import api, chain_health
from services.audit_vault.metrics import AuditVaultCollector

pytestmark = pytest.mark.django_db(databases=["audit"])


def _samples(metric_name: str) -> dict:
    for family in AuditVaultCollector().collect():
        if family.name == metric_name:
            return {tuple(sorted(s.labels.items())): s.value for s in family.samples}
    return {}


def test_chain_length_reports_zero_on_empty_chain():
    assert _samples("porukam_audit_vault_chain_length")[()] == 0


def test_chain_length_reports_entry_count():
    api.append(
        actor={}, actor_role="system", action="a", target_type="t", target_id="1", payload={}
    )
    api.append(
        actor={}, actor_role="system", action="b", target_type="t", target_id="2", payload={}
    )

    assert _samples("porukam_audit_vault_chain_length")[()] == 2


def test_checkpoint_age_absent_without_any_checkpoint():
    assert _samples("porukam_audit_vault_checkpoint_age_seconds") == {}


def test_chain_ok_absent_without_any_verification_run():
    assert _samples("porukam_audit_vault_chain_ok") == {}


def test_chain_ok_reflects_last_verification_run():
    api.append(
        actor={}, actor_role="system", action="a", target_type="t", target_id="1", payload={}
    )
    chain_health.record_verification_run()

    assert _samples("porukam_audit_vault_chain_ok")[()] == 1
    assert _samples("porukam_audit_vault_chain_verification_age_seconds")[()] < 5


def test_checkpoint_attested_metric_absent_for_fake_and_reflects_status():
    from services.audit_vault.models import AuditCheckpoint

    api.append(
        actor={}, actor_role="system", action="a", target_type="t", target_id="1", payload={}
    )
    assert _samples("porukam_audit_vault_checkpoint_attested") == {}

    cp = AuditCheckpoint.objects.create(
        seq_from=1, seq_to=1, digest="0" * 64, tsa_status="fake", timestamps=[{}], object_key="k"
    )
    assert _samples("porukam_audit_vault_checkpoint_attested") == {}

    cp.tsa_status = "unattested"
    cp.save(update_fields=["tsa_status"])
    assert _samples("porukam_audit_vault_checkpoint_attested")[()] == 0
    assert _samples("porukam_audit_vault_checkpoint_timestamps")[()] == 1

    cp.tsa_status = "attested"
    cp.timestamps = [{}, {}, {}]
    cp.save(update_fields=["tsa_status", "timestamps"])
    assert _samples("porukam_audit_vault_checkpoint_attested")[()] == 1
    assert _samples("porukam_audit_vault_checkpoint_timestamps")[()] == 3
