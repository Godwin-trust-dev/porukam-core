"""Management-команды ADR-135: `tsa_probe` (cron-проба доступности, п.4
«Дальнейших шагов») и `verify_checkpoint_timestamps` (офлайн-проверка +
экспорт пакета для `openssl ts -verify`). Сеть подменяется MockTransport."""

from __future__ import annotations

import io
import json
import shutil
import subprocess
from pathlib import Path

import httpx
import pytest
from django.core.management import CommandError, call_command

from services.audit_vault import api, checkpoint, providers
from services.audit_vault.management.commands import tsa_probe
from services.audit_vault.storage import FakeCheckpointObjectStore

from .fake_tsa import FakeTsaServer, transport_for

HOSTS = ["one.test", "two.test", "three.test", "four.test"]


@pytest.fixture(scope="module")
def servers() -> dict[str, FakeTsaServer]:
    return {host: FakeTsaServer(name=host, host=host) for host in HOSTS}


def _patch_client(monkeypatch, servers, *, broken: set[str] = frozenset()):
    base = transport_for(servers)

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.host == "ifconfig.co":
            return httpx.Response(
                200, json={"ip": "1.2.3.4", "country_iso": "KZ", "asn": "AS200532"}
            )
        if request.url.host in broken:
            raise httpx.ConnectTimeout("connect timed out")
        return base.handler(request)  # type: ignore[attr-defined]

    real_client = httpx.Client

    def factory(**kwargs):
        kwargs.pop("timeout", None)
        return real_client(transport=httpx.MockTransport(handler), **kwargs)

    monkeypatch.setattr(tsa_probe.httpx, "Client", factory)


def test_tsa_probe_logs_egress_each_endpoint_and_summary(monkeypatch, settings, servers):
    settings.TSA_ENDPOINTS = [f"http://{h}/tsr" for h in HOSTS]
    _patch_client(monkeypatch, servers, broken={"four.test"})
    out = io.StringIO()

    call_command("tsa_probe", stdout=out)

    lines = [json.loads(line) for line in out.getvalue().splitlines()]
    assert (
        lines[0]["kind"] == "egress" and lines[0]["ip"] == "1.2.3.4" and lines[0]["country"] == "KZ"
    )
    tsa_lines = [line for line in lines if line["kind"] == "tsa"]
    assert [line["ok"] for line in tsa_lines] == [True, True, True, False]
    assert all("latency_ms" in line for line in tsa_lines)
    assert tsa_lines[3]["error"].startswith("timeout")
    assert lines[-1] == {
        "at": lines[0]["at"],
        "kind": "summary",
        "ok": 3,
        "total": 4,
        "quorum": 2,
        "quorum_reached": True,
    }


def test_tsa_probe_accepts_endpoint_override_and_no_egress(monkeypatch, servers):
    _patch_client(monkeypatch, servers)
    out = io.StringIO()
    call_command("tsa_probe", "--endpoint", "http://one.test/tsr", "--no-egress", stdout=out)
    lines = [json.loads(line) for line in out.getvalue().splitlines()]
    assert [line["kind"] for line in lines] == ["tsa", "summary"]
    assert lines[0]["signer"] == "CN=one.test Signer"


@pytest.mark.django_db(databases=["audit"])
def test_verify_checkpoint_timestamps_command_reports_and_exports(servers, tmp_path: Path):
    api.append(
        actor={}, actor_role="system", action="a", target_type="t", target_id="1", payload={}
    )
    authority = providers.Rfc3161TimestampAuthority(
        endpoints=[f"http://{h}/tsr" for h in HOSTS],
        quorum=2,
        timeout=1.0,
        client_factory=lambda: httpx.Client(transport=transport_for(servers)),
    )
    result = checkpoint.compute_daily_checkpoint(
        provider=authority, store=FakeCheckpointObjectStore()
    )
    assert result is not None
    out = io.StringIO()

    call_command("verify_checkpoint_timestamps", "--export-dir", str(tmp_path), stdout=out)

    text = out.getvalue()
    assert "status=attested" in text
    assert text.count("  OK   http://") == 4
    assert "валидных меток 4, кворум 2" in text
    exported = sorted(p.name for p in tmp_path.iterdir())
    assert "00-one.test.tsq" in exported and "00-one.test.tsr" in exported
    assert "00-one.test.chain.pem" in exported and "00-one.test.ocsp.der" in exported
    assert "checkpoint.txt" in exported
    assert (
        "openssl ts -verify -queryfile 00-one.test.tsq" in (tmp_path / "checkpoint.txt").read_text()
    )

    if shutil.which("openssl"):
        run = subprocess.run(
            [
                "openssl",
                "ts",
                "-verify",
                "-queryfile",
                "00-one.test.tsq",
                "-in",
                "00-one.test.tsr",
                "-CAfile",
                "00-one.test.chain.pem",
                "-untrusted",
                "00-one.test.chain.pem",
            ],
            cwd=tmp_path,
            capture_output=True,
            text=True,
            check=False,
        )
        assert run.returncode == 0, run.stderr


@pytest.mark.django_db(databases=["audit"])
def test_verify_checkpoint_timestamps_command_fails_on_fake_checkpoint():
    api.append(
        actor={}, actor_role="system", action="a", target_type="t", target_id="1", payload={}
    )
    checkpoint.compute_daily_checkpoint(
        provider=providers.FakeTimestampAuthority(), store=FakeCheckpointObjectStore()
    )
    with pytest.raises(CommandError, match="не подтверждены"):
        call_command("verify_checkpoint_timestamps", stdout=io.StringIO())


@pytest.mark.django_db(databases=["audit"])
def test_verify_checkpoint_timestamps_command_without_checkpoints():
    with pytest.raises(CommandError, match="не найден"):
        call_command("verify_checkpoint_timestamps", stdout=io.StringIO())
