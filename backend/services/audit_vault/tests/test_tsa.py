"""RFC 3161-клиент (ADR-135): DER, TimeStampReq, разбор/проверка
TimeStampResp — на реальных сохранённых ответах четырёх TSA из ADR
(fixtures/, получены 2026-08-26 запросом `openssl ts -query -data
porukam-fixture -sha256 -cert`) и на фейковом TSA с тестовым ЦС. Сети нет."""

from __future__ import annotations

import hashlib
import shutil
import subprocess
from datetime import UTC, datetime, timedelta
from pathlib import Path

import httpx
import pytest
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import NameOID

from services.audit_vault import der, tsa

from .fake_tsa import FakeTsaServer, transport_for

FIXTURES = Path(__file__).parent / "fixtures"
REAL_TSR = sorted(FIXTURES.glob("*.tsr"))
IMPRINT = hashlib.sha256(b"porukam-fixture").digest()


@pytest.fixture(scope="module")
def server() -> FakeTsaServer:
    return FakeTsaServer()


# --- DER -------------------------------------------------------------------


@pytest.mark.parametrize("value", [0, 1, 127, 128, 255, 256, -1, -128, 2**64 - 1, 2**200])
def test_der_integer_roundtrip(value: int):
    assert der.decode_integer(der.decode(der.integer(value))) == value


@pytest.mark.parametrize(
    "dotted", ["1.2", "2.5.4.3", "1.2.840.113549.1.9.16.1.4", "2.16.840.1.101.3.4.2.1"]
)
def test_der_oid_roundtrip(dotted: str):
    assert der.decode_oid(der.decode(der.oid(dotted))) == dotted


@pytest.mark.parametrize("length", [0, 1, 127, 128, 300, 70000])
def test_der_length_roundtrip(length: int):
    node = der.decode(der.octet_string(b"x" * length))
    assert len(node.content) == length


def test_der_generalized_time_roundtrip_with_fraction():
    moment = datetime(2026, 8, 26, 8, 43, 57, 918000, tzinfo=UTC)
    encoded = der.generalized_time(moment)
    assert encoded.endswith(b"20260826084357.918Z")
    assert der.decode_generalized_time(der.decode(encoded)) == moment


def test_der_rejects_trailing_bytes_and_truncation():
    with pytest.raises(der.DerError):
        der.decode(der.integer(1) + b"\x00")
    with pytest.raises(der.DerError):
        der.decode(b"\x30\x05\x02\x01")


# --- TimeStampReq ----------------------------------------------------------


def test_request_matches_openssl_query_fixture():
    """Наш TimeStampReq байт-в-байт равен тому, что собрал openssl ts -query."""
    fixture = (FIXTURES / "porukam-fixture.tsq").read_bytes()
    parsed = tsa.parse_timestamp_request(fixture)
    assert parsed.alg == "sha256"
    assert parsed.message_imprint == IMPRINT
    assert parsed.cert_req is True
    assert parsed.nonce is not None
    assert tsa.build_timestamp_request(IMPRINT, nonce=parsed.nonce) == fixture


def test_request_rejects_bad_imprint_or_nonce():
    with pytest.raises(tsa.TsaError):
        tsa.build_timestamp_request(b"short", nonce=1)
    with pytest.raises(tsa.TsaError):
        tsa.build_timestamp_request(IMPRINT, nonce=0)
    with pytest.raises(tsa.TsaError):
        tsa.build_timestamp_request(IMPRINT, alg="md5", nonce=1)


# --- реальные ответы TSA ---------------------------------------------------


@pytest.mark.parametrize("path", REAL_TSR, ids=[p.name for p in REAL_TSR])
def test_real_tsr_is_granted_and_verifies_offline(path: Path):
    request = tsa.parse_timestamp_request((FIXTURES / "porukam-fixture.tsq").read_bytes())
    result = tsa.verify_timestamp_token(
        path.read_bytes(), message_imprint=IMPRINT, alg="sha256", nonce=request.nonce
    )
    assert result.ok, result.errors
    info = result.response.tst_info
    assert info is not None
    assert info.gen_time.date().isoformat() == "2026-08-26"
    assert info.nonce == request.nonce
    assert result.signer_certificate is not None
    chain, _complete = tsa.build_certificate_chain(
        result.signer_certificate, list(result.response.certificates)
    )
    assert chain[0] is result.signer_certificate
    assert len(chain) >= 2  # certReq=true — TSA вложил подписанта и хотя бы издателя


def test_real_tsr_signature_algorithms_cover_rsa_and_ecdsa():
    algs = set()
    for path in REAL_TSR:
        response = tsa.parse_timestamp_response(path.read_bytes())
        assert response.signer is not None
        algs.add(response.signer.signature_alg)
    assert tsa.OID_RSA_ENCRYPTION in algs  # certum/sectigo: rsaEncryption + sha384
    assert "1.2.840.113549.1.1.11" in algs  # swisssign: sha256WithRSAEncryption
    assert "1.2.840.10045.4.3.4" in algs  # freetsa: ecdsa-with-SHA512


@pytest.mark.parametrize("path", REAL_TSR, ids=[p.name for p in REAL_TSR])
def test_real_tsr_rejected_on_foreign_imprint_and_nonce(path: Path):
    result = tsa.verify_timestamp_token(
        path.read_bytes(), message_imprint=b"\x00" * 32, alg="sha256", nonce=42
    )
    assert not result.ok
    assert "messageImprint не совпадает с хешем чекпойнта" in result.errors
    assert "nonce не совпадает" in result.errors


def test_real_tsr_tampered_signature_is_detected():
    body = bytearray((FIXTURES / "tsa.swisssign.net.tsr").read_bytes())
    body[-1] ^= 0x01  # последний байт — внутри signature OCTET STRING
    request = tsa.parse_timestamp_request((FIXTURES / "porukam-fixture.tsq").read_bytes())
    result = tsa.verify_timestamp_token(
        bytes(body), message_imprint=IMPRINT, alg="sha256", nonce=request.nonce
    )
    assert "подпись SignerInfo не сходится с ключом сертификата подписанта" in result.errors


def test_real_chain_links_verify_when_root_embedded():
    response = tsa.parse_timestamp_response((FIXTURES / "freetsa.org.tsr").read_bytes())
    assert response.signer is not None
    signer = tsa.find_signer_certificate(response.signer, list(response.certificates))
    assert signer is not None
    chain, complete = tsa.build_certificate_chain(signer, list(response.certificates))
    assert complete
    ok, errors = tsa.verify_chain_links(chain)
    assert ok, errors


# --- якоря доверия (ADR-147): SHA-1-корень Certum --------------------------
# Живой ответ time.certum.pl от 31.08.2026 и корень Certum Trusted Network CA
# (самоподпись sha1WithRSAEncryption, 2008), докачанный тогда же по AIA
# caIssuers, — см. docs/tasks/Задача_fix_audit-vault-sha1-root.md. Сети нет:
# цепочка собирается из файлов фикстуры.

CERTUM_31_08 = FIXTURES / "certum-2026-08-31"
CERTUM_ROOT_SHA256 = "5c58468d55f58e497e743982d2b50010b6d165374acf83a7d4a32db768c4408e"


def _certum_root() -> x509.Certificate:
    return x509.load_der_x509_certificate(
        (CERTUM_31_08 / "certum-trusted-network-ca.der").read_bytes()
    )


def _certum_pem_chain() -> list[x509.Certificate]:
    return [
        x509.load_pem_x509_certificate((CERTUM_31_08 / name).read_bytes())
        for name in ("chain-1-signer.pem", "chain-2-intermediate.pem", "chain-3-crosssigned.pem")
    ]


def test_trust_anchor_catalog_pins_certum_root():
    """Каталог якорей содержит корень Certum с отпечатком, зафиксированным
    при пиновке (trust_anchors/README.md, постановка §2.6)."""
    anchor = (tsa.TRUST_ANCHORS_DIR / "certum-trusted-network-ca.der").read_bytes()
    assert hashlib.sha256(anchor).hexdigest() == CERTUM_ROOT_SHA256
    assert anchor == (CERTUM_31_08 / "certum-trusted-network-ca.der").read_bytes()


def test_certum_chain_with_sha1_root_is_complete_via_trust_anchor():
    """Цепочка живого ответа Certum + корень признаётся полной через якорь
    (subject + SPKI побайтно). Самоподпись корня НЕ проверяется вовсе —
    до ADR-147 ровно на ней (`cryptography` отказывает SHA-1 по политике)
    цепочка признавалась неполной и метка выпадала из кворума."""
    response = tsa.parse_timestamp_response((CERTUM_31_08 / "certum-response.tsr").read_bytes())
    assert response.signer is not None
    # Три сертификата ответа — те же, что сохранены отдельными PEM-фикстурами.
    assert sorted(c.subject.rfc4514_string() for c in response.certificates) == sorted(
        c.subject.rfc4514_string() for c in _certum_pem_chain()
    )
    signer = tsa.find_signer_certificate(response.signer, list(response.certificates))
    assert signer is not None
    root = _certum_root()
    chain, complete = tsa.build_certificate_chain(signer, [*response.certificates, root])
    assert complete
    assert len(chain) == 4 and chain[-1] == root
    ok, errors = tsa.verify_chain_links(chain)
    assert ok, errors


def _impostor_with_anchor_subject() -> x509.Certificate:
    """Сертификат с subject якоря Certum, но ЧУЖИМ ключом (и не самоподписанный)."""
    key = ec.generate_private_key(ec.SECP256R1())
    now = datetime.now(UTC)
    return (
        x509.CertificateBuilder()
        .subject_name(_certum_root().subject)
        .issuer_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "Impostor CA")]))
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - timedelta(days=1))
        .not_valid_after(now + timedelta(days=1))
        .sign(key, hashes.SHA256())
    )


def test_root_not_matching_anchor_does_not_close_chain():
    """Корень с несовпадающим subject/SPKI цепочку не закрывает.

    Тест «изменённый байт подписи корня» из постановки писался под вариант A:
    при якорной проверке (вариант C, ADR-147) подпись корня не участвует
    вовсе — корень с подменённой подписью совпадал бы с якорем по subject+SPKI
    и это было бы корректно (доверие даёт пиновка ключа, не самоподпись).
    Подделку ловит несовпадение КЛЮЧА: сертификат с subject якоря, но чужим
    SPKI полноту не даёт; подделка подписи ПРОМЕЖУТОЧНОГО звена по-прежнему
    ловится verify_chain_links (следующий тест)."""
    chain_certs = _certum_pem_chain()
    # Без корня цепочка не полна: chain-3 — не якорь и не самоподписан.
    ok, errors = tsa.verify_chain_links(chain_certs)
    assert not ok
    assert (
        "цепочка не завершается доверенным корнем (ни якорь ADR-147, ни самоподписанный)" in errors
    )
    # Настоящий корень закрывает цепочку сам по себе, самозванец — нет.
    ok, _ = tsa.verify_chain_links([_certum_root()])
    assert ok
    impostor = _impostor_with_anchor_subject()
    ok, errors = tsa.verify_chain_links([impostor])
    assert not ok and errors
    # И в сборке цепочки самозванец не принимается издателем chain-3.
    signer = chain_certs[0]
    _, complete = tsa.build_certificate_chain(signer, [*chain_certs[1:], impostor])
    assert not complete


def test_tampered_intermediate_signature_is_still_caught_with_anchor():
    """Якорь освобождает только последнее звено от проверки самоподписи:
    подписи промежуточных звеньев verify_chain_links проверяет как раньше."""
    c1, c2, c3 = _certum_pem_chain()
    tampered_der = bytearray(c2.public_bytes(serialization.Encoding.DER))
    tampered_der[-1] ^= 0x01  # последний байт DER — внутри BIT STRING подписи
    tampered = x509.load_der_x509_certificate(bytes(tampered_der))
    ok, errors = tsa.verify_chain_links([c1, tampered, c3, _certum_root()])
    assert not ok
    assert any(error.startswith("звено 1:") for error in errors), errors


# --- фейковый TSA ----------------------------------------------------------


def test_fake_tsa_token_verifies_and_reports_fields(server: FakeTsaServer):
    tsq = tsa.build_timestamp_request(IMPRINT, nonce=777)
    # Дата — относительно now: серт фейкового TSA валиден с now-1d (fake_tsa),
    # зашитая календарная дата превращала тест в часовую бомбу.
    at = datetime.now(UTC).replace(microsecond=0) - timedelta(hours=1)
    result = tsa.verify_timestamp_token(
        server.respond(tsq, gen_time=at), message_imprint=IMPRINT, alg="sha256", nonce=777
    )
    assert result.ok, result.errors
    info = result.response.tst_info
    assert info is not None
    assert info.gen_time == at
    assert info.serial == 0x1234
    assert info.tsa_name == "CN=Fake TSA Signer"


def test_fake_tsa_rejection_status_is_not_granted(server: FakeTsaServer):
    tsq = tsa.build_timestamp_request(IMPRINT, nonce=1)
    result = tsa.verify_timestamp_token(
        server.respond(tsq, status=2), message_imprint=IMPRINT, alg="sha256", nonce=1
    )
    assert not result.ok
    assert result.errors[0].startswith("статус rejection")


def test_fake_tsa_without_certificates_needs_archived_chain(server: FakeTsaServer):
    tsq = tsa.build_timestamp_request(IMPRINT, nonce=5)
    tsr = server.respond(tsq, include_certs=False)
    bare = tsa.verify_timestamp_token(tsr, message_imprint=IMPRINT, alg="sha256", nonce=5)
    assert "сертификат подписанта не найден ни в ответе, ни в архивной цепочке" in bare.errors
    with_chain = tsa.verify_timestamp_token(
        tsr, message_imprint=IMPRINT, alg="sha256", nonce=5, extra_certificates=[server.cert]
    )
    assert with_chain.ok, with_chain.errors


def test_fake_tsa_nonce_mismatch_is_rejected(server: FakeTsaServer):
    tsq = tsa.build_timestamp_request(IMPRINT, nonce=10)
    result = tsa.verify_timestamp_token(
        server.respond(tsq, nonce_override=11), message_imprint=IMPRINT, alg="sha256", nonce=10
    )
    assert result.errors == ("nonce не совпадает",)


@pytest.mark.skipif(shutil.which("openssl") is None, reason="нет openssl")
def test_fake_tsa_token_is_accepted_by_openssl_ts_verify(server: FakeTsaServer, tmp_path: Path):
    tsq = tsa.build_timestamp_request(IMPRINT, nonce=99)
    (tmp_path / "q.tsq").write_bytes(tsq)
    (tmp_path / "r.tsr").write_bytes(server.respond(tsq))
    (tmp_path / "root.pem").write_bytes(server.root_pem())
    run = subprocess.run(
        [
            "openssl",
            "ts",
            "-verify",
            "-queryfile",
            str(tmp_path / "q.tsq"),
            "-in",
            str(tmp_path / "r.tsr"),
            "-CAfile",
            str(tmp_path / "root.pem"),
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    assert run.returncode == 0, run.stderr
    assert "Verification: OK" in run.stdout


# --- один запрос: request_timestamp + архивация PKI ------------------------


def _client(server: FakeTsaServer) -> httpx.Client:
    return httpx.Client(transport=transport_for({server.host: server}))


def test_request_timestamp_archives_chain_and_ocsp(server: FakeTsaServer):
    with _client(server) as client:
        record = tsa.request_timestamp(
            f"http://{server.host}/tsr",
            IMPRINT,
            alg="sha256",
            nonce=123,
            client=client,
            now=lambda: datetime.now(UTC),
        )
    assert record.tsa == f"http://{server.host}/tsr"
    assert record.nonce == 123
    assert len(record.chain_pem) == 2 and record.chain_complete
    assert record.revocation is not None
    assert record.revocation["kind"] == "ocsp"
    assert record.revocation["status"] == "good"
    assert record.warnings == []
    as_json = record.as_json()
    assert as_json["nonce"] == "0x7b"
    assert as_json["tsq_b64"] and as_json["tsr_b64"]


def test_request_timestamp_completes_chain_via_aia_when_root_missing():
    server = FakeTsaServer(host="aia.test")

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.host == server.host:
            return httpx.Response(200, content=server.respond(request.content, include_root=False))
        return server.handle(request)

    with httpx.Client(transport=httpx.MockTransport(handler)) as client:
        record = tsa.request_timestamp(
            f"http://{server.host}/",
            IMPRINT,
            alg="sha256",
            nonce=1,
            client=client,
            now=lambda: datetime.now(UTC),
        )
    assert record.chain_complete and len(record.chain_pem) == 2


def test_request_timestamp_falls_back_to_crl_then_none():
    server = FakeTsaServer(host="crl-only.test")

    def crl_only(request: httpx.Request) -> httpx.Response:
        if request.url.host == f"ocsp.{server.host}":
            return httpx.Response(500)
        return server.handle(request)

    with httpx.Client(transport=httpx.MockTransport(crl_only)) as client:
        record = tsa.request_timestamp(
            f"http://{server.host}/",
            IMPRINT,
            alg="sha256",
            nonce=1,
            client=client,
            now=lambda: datetime.now(UTC),
        )
    assert record.revocation is not None and record.revocation["kind"] == "crl"
    assert record.revocation["status"] == "good"

    def nothing(request: httpx.Request) -> httpx.Response:
        if request.url.host == server.host:
            return server.handle(request)
        return httpx.Response(404)

    with httpx.Client(transport=httpx.MockTransport(nothing)) as client:
        record = tsa.request_timestamp(
            f"http://{server.host}/",
            IMPRINT,
            alg="sha256",
            nonce=1,
            client=client,
            now=lambda: datetime.now(UTC),
        )
    assert record.revocation is None
    assert "статус отзыва (OCSP/CRL) на момент штампования не получен" in record.warnings


def test_request_timestamp_maps_http_and_timeout_errors():
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.host == "slow.test":
            raise httpx.ReadTimeout("read timed out")
        return httpx.Response(503)

    with httpx.Client(transport=httpx.MockTransport(handler)) as client:
        with pytest.raises(tsa.TsaError, match="timeout"):
            tsa.request_timestamp(
                "http://slow.test/",
                IMPRINT,
                alg="sha256",
                nonce=1,
                client=client,
                now=lambda: datetime.now(UTC),
            )
        with pytest.raises(tsa.TsaError, match="http 503"):
            tsa.request_timestamp(
                "http://down.test/",
                IMPRINT,
                alg="sha256",
                nonce=1,
                client=client,
                now=lambda: datetime.now(UTC),
            )
