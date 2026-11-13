"""Ежесуточный checkpoint (tech-spec.md §10.3, ADR-135): формат записи
(alg/root/leaves/host_id/timestamps), кворум → tsa_status + алерт,
офлайн-проверка меток против архивной цепочки. WORM-хранилище — фейк
(реальный S3CheckpointObjectStore требует boto3/MinIO), TSA — фейковые
серверы через httpx.MockTransport, сети нет."""

from __future__ import annotations

import hashlib
import json

import httpx
import pytest
import structlog

from services.audit_vault import api, checkpoint, providers
from services.audit_vault.models import AuditCheckpoint
from services.audit_vault.providers import FakeTimestampAuthority
from services.audit_vault.storage import FakeCheckpointObjectStore

from .fake_tsa import FakeTsaServer, transport_for

pytestmark = pytest.mark.django_db(databases=["audit"])
HOSTS = ["one.test", "two.test", "three.test", "four.test"]


@pytest.fixture(scope="module")
def servers() -> dict[str, FakeTsaServer]:
    return {host: FakeTsaServer(name=host, host=host) for host in HOSTS}


def _rfc3161(servers, *, broken: set[str] = frozenset()) -> providers.Rfc3161TimestampAuthority:
    base = transport_for(servers)

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.host in broken:
            return httpx.Response(502)
        return base.handler(request)  # type: ignore[attr-defined]

    return providers.Rfc3161TimestampAuthority(
        endpoints=[f"http://{h}/tsr" for h in HOSTS],
        quorum=2,
        timeout=1.0,
        client_factory=lambda: httpx.Client(transport=httpx.MockTransport(handler)),
    )


def _append(n: int):
    last = None
    for i in range(n):
        last = api.append(
            actor={},
            actor_role="system",
            action=f"a{i}",
            target_type="t",
            target_id=str(i),
            payload={"i": i},
        )
    return last


def test_daily_checkpoint_noop_without_entries():
    result = checkpoint.compute_daily_checkpoint(
        provider=FakeTimestampAuthority(), store=FakeCheckpointObjectStore()
    )
    assert result is None


def test_daily_checkpoint_with_fake_tsa_is_marked_fake(settings):
    settings.HOST_ID = "prod-kz-1"
    latest = _append(2)
    store = FakeCheckpointObjectStore()

    result = checkpoint.compute_daily_checkpoint(provider=FakeTimestampAuthority(), store=store)

    assert result is not None
    assert (result.seq_from, result.seq_to) == (1, 2)
    assert result.digest == latest.this_hash
    assert result.alg == "sha256"
    assert result.host_id == "prod-kz-1"
    assert result.tsa_status == "fake"
    assert result.timestamps[0]["tsa"] == "tsa_fake"
    assert AuditCheckpoint.objects.count() == 1


def test_worm_object_holds_leaves_root_alg_host_and_layers(settings, servers):
    settings.HOST_ID = "prod-kz-1"
    latest = _append(3)
    store = FakeCheckpointObjectStore()

    result = checkpoint.compute_daily_checkpoint(provider=_rfc3161(servers), store=store)

    assert result is not None
    record = json.loads(store.objects[result.object_key])
    assert record["format"] == checkpoint.CHECKPOINT_FORMAT
    assert record["alg"] == "sha256"
    assert record["root"] == latest.this_hash
    assert record["host_id"] == "prod-kz-1"
    assert record["tsa_status"] == "attested"
    assert [t["tsa"] for t in record["timestamps"]] == [f"http://{h}/tsr" for h in HOSTS]
    assert record["tsa_failures"] == []
    leaves = record["leaves"]["entries"]
    assert [leaf["seq"] for leaf in leaves] == [1, 2, 3]
    # Листья достаточны для пересчёта корня (ADR-135 п.6): восстанавливаем цепочку.
    prev = "0" * 64
    for leaf in leaves:
        assert json.loads(leaf["canonical"])["prev_hash"] == prev
        prev = hashlib.sha256(prev.encode() + leaf["canonical"].encode()).hexdigest()
        assert prev == leaf["this_hash"]
    assert prev == record["root"]
    assert result.tsa_status == "attested"
    assert len(result.timestamps) == 4


def test_quorum_shortfall_marks_unattested_and_logs_alert_event(servers):
    _append(1)
    store = FakeCheckpointObjectStore()
    provider = _rfc3161(servers, broken={"two.test", "three.test", "four.test"})

    with structlog.testing.capture_logs() as logs:
        result = checkpoint.compute_daily_checkpoint(provider=provider, store=store)

    assert result is not None
    assert result.tsa_status == "unattested"
    assert len(result.timestamps) == 1
    assert len(result.tsa_failures) == 3
    alerts = [log for log in logs if log["event"] == checkpoint.EVENT_CHECKPOINT_UNATTESTED]
    assert len(alerts) == 1
    assert alerts[0]["log_level"] == "error"
    assert alerts[0]["attested"] == 1 and alerts[0]["quorum"] == 2
    record = json.loads(store.objects[result.object_key])
    assert record["tsa_status"] == "unattested"


def test_missing_host_id_is_recorded_as_null_with_warning(settings, caplog):
    settings.HOST_ID = ""
    _append(1)
    store = FakeCheckpointObjectStore()
    with caplog.at_level("WARNING"):
        result = checkpoint.compute_daily_checkpoint(provider=FakeTimestampAuthority(), store=store)
    assert result is not None and result.host_id == ""
    assert json.loads(store.objects[result.object_key])["host_id"] is None
    assert any("HOST_ID" in message for message in caplog.messages)


def test_daily_checkpoint_second_run_without_new_entries_is_noop():
    _append(1)
    store = FakeCheckpointObjectStore()
    provider = FakeTimestampAuthority()

    first = checkpoint.compute_daily_checkpoint(provider=provider, store=store)
    second = checkpoint.compute_daily_checkpoint(provider=provider, store=store)

    assert first is not None
    assert second is None
    assert AuditCheckpoint.objects.count() == 1


def test_daily_checkpoint_covers_only_new_range_on_next_run():
    _append(1)
    store = FakeCheckpointObjectStore()
    provider = FakeTimestampAuthority()
    checkpoint.compute_daily_checkpoint(provider=provider, store=store)

    _append(1)
    second = checkpoint.compute_daily_checkpoint(provider=provider, store=store)

    assert second is not None
    assert (second.seq_from, second.seq_to) == (2, 2)


# --- verify_checkpoint_timestamps ------------------------------------------


def test_verify_checkpoint_timestamps_offline_against_archived_chain(servers):
    _append(2)
    result = checkpoint.compute_daily_checkpoint(
        provider=_rfc3161(servers), store=FakeCheckpointObjectStore()
    )
    assert result is not None
    # Перечитываем из БД — проверка не должна зависеть от объектов в памяти.
    stored = AuditCheckpoint.objects.get(pk=result.pk)
    verification = checkpoint.verify_checkpoint_timestamps(stored)
    assert verification.ok
    assert verification.valid == 4 and verification.quorum == 2
    assert all(check.ok for check in verification.checks)
    assert verification.checks[0].signer == "CN=one.test Signer"


def test_verify_checkpoint_timestamps_detects_tampered_root(servers):
    _append(1)
    result = checkpoint.compute_daily_checkpoint(
        provider=_rfc3161(servers), store=FakeCheckpointObjectStore()
    )
    assert result is not None
    result.digest = "ff" * 32
    verification = checkpoint.verify_checkpoint_timestamps(result)
    assert not verification.ok and verification.valid == 0
    assert "messageImprint не совпадает с хешем чекпойнта" in verification.checks[0].errors


def test_verify_checkpoint_timestamps_uses_only_archived_chain(servers):
    """Метка без вложенных сертификатов проверяется по chain_pem записи."""
    _append(1)
    result = checkpoint.compute_daily_checkpoint(
        provider=_rfc3161(servers), store=FakeCheckpointObjectStore()
    )
    assert result is not None
    layer = dict(result.timestamps[0])
    layer["chain_pem"] = []
    check = checkpoint.verify_timestamp_record(layer, root=result.digest, alg="sha256")
    assert not check.ok
    assert "архивная цепочка сертификатов отсутствует" in check.errors


def test_verify_checkpoint_timestamps_fails_for_fake_and_unattested(servers):
    _append(1)
    fake = checkpoint.compute_daily_checkpoint(
        provider=FakeTimestampAuthority(), store=FakeCheckpointObjectStore()
    )
    assert fake is not None
    verification = checkpoint.verify_checkpoint_timestamps(fake)
    assert not verification.ok
    assert verification.checks[0].errors == ("нет .tsr (фейковая метка)",)

    _append(1)
    unattested = checkpoint.compute_daily_checkpoint(
        provider=_rfc3161(servers, broken={"two.test", "three.test", "four.test"}),
        store=FakeCheckpointObjectStore(),
    )
    assert unattested is not None
    verification = checkpoint.verify_checkpoint_timestamps(unattested)
    assert not verification.ok and verification.valid == 1
