"""Кворум TSA (ADR-135 п.2): параллельные запросы к четырём фейковым TSA
через httpx.MockTransport — сети нет."""

from __future__ import annotations

import httpx
import pytest

from common import circuit
from services.audit_vault import providers

from .fake_tsa import FakeTsaServer, transport_for

DIGEST = "ba5531480e5efc46898b8b8263bbbea3ba296e45833aeae2185158654eba321e"
HOSTS = ["one.test", "two.test", "three.test", "four.test"]


@pytest.fixture(scope="module")
def servers() -> dict[str, FakeTsaServer]:
    return {host: FakeTsaServer(name=host, host=host) for host in HOSTS}


def _authority(
    servers: dict[str, FakeTsaServer], *, quorum: int = 2, behaviour: dict[str, str] | None = None
) -> providers.Rfc3161TimestampAuthority:
    """behaviour: host → timeout | http500 | nonce_mismatch | imprint_mismatch."""
    behaviour = behaviour or {}
    base = transport_for(servers)

    def handler(request: httpx.Request) -> httpx.Response:
        mode = behaviour.get(request.url.host or "")
        server = servers.get(request.url.host or "")
        if mode == "timeout":
            raise httpx.ReadTimeout("read timed out")
        if mode == "http500":
            return httpx.Response(500)
        if mode == "nonce_mismatch" and server is not None:
            return httpx.Response(200, content=server.respond(request.content, nonce_override=1))
        if mode == "imprint_mismatch" and server is not None:
            return httpx.Response(
                200, content=server.respond(request.content, imprint_override=b"\x01" * 32)
            )
        return base.handler(request)  # type: ignore[attr-defined]

    return providers.Rfc3161TimestampAuthority(
        endpoints=[f"http://{host}/tsr" for host in HOSTS],
        quorum=quorum,
        timeout=1.0,
        client_factory=lambda: httpx.Client(transport=httpx.MockTransport(handler)),
    )


def test_fake_tsa_stamp_is_marked_fake_with_one_layer():
    outcome = providers.FakeTimestampAuthority().stamp("deadbeef")
    assert outcome.status == providers.STATUS_FAKE
    assert not outcome.attested
    assert len(outcome.timestamps) == 1
    assert outcome.timestamps[0]["tsa"] == "tsa_fake"
    assert outcome.timestamps[0]["tsr_b64"] is None


def test_all_four_granted_gives_attested_with_four_layers(servers):
    circuit._reset_for_tests()
    outcome = _authority(servers).stamp(DIGEST)
    assert outcome.status == providers.STATUS_ATTESTED
    assert [t["tsa"] for t in outcome.timestamps] == [f"http://{h}/tsr" for h in HOSTS]
    assert outcome.failures == []
    for layer in outcome.timestamps:
        assert layer["alg"] == "sha256"
        assert layer["tsr_b64"] and layer["tsq_b64"]
        assert len(layer["chain_pem"]) == 2 and layer["chain_complete"]
        assert layer["revocation"]["kind"] == "ocsp"
    assert circuit.states()["tsa:one.test"].successes == 1


def test_each_tsa_gets_its_own_nonce(servers):
    for server in servers.values():
        server.requests.clear()
    _authority(servers).stamp(DIGEST)
    from services.audit_vault import tsa

    nonces = {tsa.parse_timestamp_request(s.requests[-1]).nonce for s in servers.values()}
    assert len(nonces) == 4
    assert all(n and n > 0 for n in nonces)


def test_quorum_reached_with_exactly_two_of_four(servers):
    outcome = _authority(
        servers, behaviour={"three.test": "http500", "four.test": "timeout"}
    ).stamp(DIGEST)
    assert outcome.status == providers.STATUS_ATTESTED
    assert len(outcome.timestamps) == 2
    assert {f["tsa"] for f in outcome.failures} == {"http://three.test/tsr", "http://four.test/tsr"}


def test_quorum_shortfall_gives_unattested_with_failure_reasons(servers):
    circuit._reset_for_tests()
    outcome = _authority(
        servers,
        behaviour={"two.test": "http500", "three.test": "timeout", "four.test": "nonce_mismatch"},
    ).stamp(DIGEST)
    assert outcome.status == providers.STATUS_UNATTESTED
    assert len(outcome.timestamps) == 1
    errors = {f["tsa"]: f["error"] for f in outcome.failures}
    assert errors["http://two.test/tsr"] == "http 500"
    assert errors["http://three.test/tsr"].startswith("timeout")
    assert errors["http://four.test/tsr"] == "nonce не совпадает"
    assert circuit.states()["tsa:four.test"].failures == 1


def test_timeout_of_one_of_four_does_not_block_the_rest(servers):
    outcome = _authority(servers, behaviour={"two.test": "timeout"}).stamp(DIGEST)
    assert outcome.status == providers.STATUS_ATTESTED
    assert len(outcome.timestamps) == 3
    assert outcome.failures[0]["tsa"] == "http://two.test/tsr"


def test_imprint_mismatch_provider_is_rejected(servers):
    outcome = _authority(servers, behaviour={"one.test": "imprint_mismatch"}).stamp(DIGEST)
    assert len(outcome.timestamps) == 3
    assert outcome.failures[0]["error"] == "messageImprint не совпадает с хешем чекпойнта"


def test_authority_validates_configuration():
    with pytest.raises(ValueError):
        providers.Rfc3161TimestampAuthority(endpoints=[], quorum=1, timeout=1)
    with pytest.raises(ValueError):
        providers.Rfc3161TimestampAuthority(endpoints=["http://a"], quorum=2, timeout=1)


def test_default_authority_follows_settings(settings):
    settings.AUDIT_VAULT_TSA_PROVIDER = "fake"
    assert isinstance(providers.default_timestamp_authority(), providers.FakeTimestampAuthority)
    settings.AUDIT_VAULT_TSA_PROVIDER = "rfc3161"
    authority = providers.default_timestamp_authority()
    assert isinstance(authority, providers.Rfc3161TimestampAuthority)
    assert authority.quorum == settings.TSA_QUORUM
    settings.AUDIT_VAULT_TSA_PROVIDER = "gost"
    with pytest.raises(ValueError):
        providers.default_timestamp_authority()


def test_default_endpoints_are_the_four_from_adr_135(settings):
    assert settings.TSA_ENDPOINTS == [
        "http://tsa.swisssign.net",
        "http://time.certum.pl",
        "http://timestamp.sectigo.com/qualified",
        "https://freetsa.org/tsr",
    ]
    assert settings.TSA_QUORUM == 2
    assert settings.TSA_TIMEOUT == 10.0
