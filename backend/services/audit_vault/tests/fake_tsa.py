"""Фейковый TSA для тестов (сеть запрещена): свой тестовый корневой ЦС +
сертификат подписанта с EKU timeStamping, выдаёт настоящий TimeStampResp
(CMS SignedData над TSTInfo, ECDSA P-256/SHA-256, ESSCertIDv2) — его
принимает и `tsa.verify_timestamp_token`, и `openssl ts -verify`. Отдаёт
также OCSP-ответ, CRL и сертификат издателя по «своим» URL, чтобы
проверить архивацию PKI-контекста без сети (через httpx.MockTransport)."""

from __future__ import annotations

import hashlib
from datetime import UTC, datetime, timedelta

import httpx
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509 import ocsp
from cryptography.x509.oid import AuthorityInformationAccessOID, ExtendedKeyUsageOID, NameOID

from services.audit_vault import der, tsa

OID_ECDSA_SHA256 = "1.2.840.10045.4.3.2"
OID_SIGNING_CERT_V2 = "1.2.840.113549.1.9.16.2.47"
POLICY_OID = "1.3.6.1.4.1.99999.1.1"


class FakeTsaServer:
    def __init__(self, name: str = "Fake TSA", *, host: str = "fake-tsa.test") -> None:
        self.name = name
        self.host = host
        self.ocsp_url = f"http://ocsp.{host}/"
        self.crl_url = f"http://crl.{host}/root.crl"
        self.ca_issuers_url = f"http://ca.{host}/root.cer"
        self.requests: list[bytes] = []

        now = datetime.now(UTC)
        self.root_key = ec.generate_private_key(ec.SECP256R1())
        root_name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, f"{name} Root CA")])
        self.root_cert = (
            x509.CertificateBuilder()
            .subject_name(root_name)
            .issuer_name(root_name)
            .public_key(self.root_key.public_key())
            .serial_number(x509.random_serial_number())
            .not_valid_before(now - timedelta(days=1))
            .not_valid_after(now + timedelta(days=3650))
            .add_extension(x509.BasicConstraints(ca=True, path_length=None), critical=True)
            .add_extension(
                x509.KeyUsage(
                    digital_signature=True,
                    content_commitment=False,
                    key_encipherment=False,
                    data_encipherment=False,
                    key_agreement=False,
                    key_cert_sign=True,
                    crl_sign=True,
                    encipher_only=False,
                    decipher_only=False,
                ),
                critical=True,
            )
            .add_extension(
                x509.SubjectKeyIdentifier.from_public_key(self.root_key.public_key()),
                critical=False,
            )
            .sign(self.root_key, hashes.SHA256())
        )

        self.key = ec.generate_private_key(ec.SECP256R1())
        self.cert = (
            x509.CertificateBuilder()
            .subject_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, f"{name} Signer")]))
            .issuer_name(root_name)
            .public_key(self.key.public_key())
            .serial_number(x509.random_serial_number())
            .not_valid_before(now - timedelta(days=1))
            .not_valid_after(now + timedelta(days=365))
            .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
            .add_extension(
                x509.ExtendedKeyUsage([ExtendedKeyUsageOID.TIME_STAMPING]), critical=True
            )
            .add_extension(
                x509.AuthorityInformationAccess(
                    [
                        x509.AccessDescription(
                            AuthorityInformationAccessOID.OCSP,
                            x509.UniformResourceIdentifier(self.ocsp_url),
                        ),
                        x509.AccessDescription(
                            AuthorityInformationAccessOID.CA_ISSUERS,
                            x509.UniformResourceIdentifier(self.ca_issuers_url),
                        ),
                    ]
                ),
                critical=False,
            )
            .add_extension(
                x509.CRLDistributionPoints(
                    [
                        x509.DistributionPoint(
                            full_name=[x509.UniformResourceIdentifier(self.crl_url)],
                            relative_name=None,
                            reasons=None,
                            crl_issuer=None,
                        )
                    ]
                ),
                critical=False,
            )
            .sign(self.root_key, hashes.SHA256())
        )

    # --- TimeStampResp ------------------------------------------------------

    def respond(
        self,
        tsq: bytes,
        *,
        gen_time: datetime | None = None,
        nonce_override: int | None = None,
        imprint_override: bytes | None = None,
        status: int = 0,
        include_certs: bool = True,
        include_root: bool = True,
        serial: int = 0x1234,
    ) -> bytes:
        self.requests.append(tsq)
        if status != 0:
            return der.sequence(
                der.sequence(der.integer(status), der.sequence(der.utf8_string("rejected by test")))
            )
        request = tsa.parse_timestamp_request(tsq)
        gen_time = gen_time or datetime.now(UTC)
        nonce = request.nonce if nonce_override is None else nonce_override
        imprint = imprint_override or request.message_imprint

        tst_info = der.sequence(
            der.integer(1),
            der.oid(POLICY_OID),
            der.sequence(
                der.algorithm_identifier(tsa.HASH_ALGORITHMS[request.alg]),
                der.octet_string(imprint),
            ),
            der.integer(serial),
            der.generalized_time(gen_time),
            *([der.integer(nonce)] if nonce is not None else []),
            der.explicit(0, der.tlv(der.CONTEXT_CONSTRUCTED | 4, self.cert.subject.public_bytes())),
        )
        return self._sign(tst_info, include_certs=include_certs, include_root=include_root)

    def _sign(self, tst_info: bytes, *, include_certs: bool, include_root: bool) -> bytes:
        cert_der = self.cert.public_bytes(serialization.Encoding.DER)
        attrs = [
            der.sequence(
                der.oid(tsa.OID_ATTR_CONTENT_TYPE), der.set_of(der.oid(tsa.OID_CT_TSTINFO))
            ),
            der.sequence(
                der.oid(tsa.OID_ATTR_MESSAGE_DIGEST),
                der.set_of(der.octet_string(hashlib.sha256(tst_info).digest())),
            ),
            der.sequence(
                der.oid(OID_SIGNING_CERT_V2),
                der.set_of(
                    der.sequence(
                        der.sequence(
                            der.sequence(der.octet_string(hashlib.sha256(cert_der).digest()))
                        )
                    )
                ),
            ),
        ]
        attrs_content = b"".join(sorted(attrs))
        # Подписывается SET OF (0x31), в SignerInfo кладётся [0] IMPLICIT (0xA0).
        signature = self.key.sign(der.tlv(der.SET, attrs_content), ec.ECDSA(hashes.SHA256()))
        signer_info = der.sequence(
            der.integer(1),
            der.sequence(self.cert.issuer.public_bytes(), der.integer(self.cert.serial_number)),
            der.algorithm_identifier(tsa.HASH_ALGORITHMS["sha256"]),
            der.implicit_constructed(0, attrs_content),
            der.algorithm_identifier(OID_ECDSA_SHA256, with_null=False),
            der.octet_string(signature),
        )
        certs: list[bytes] = []
        if include_certs:
            certs.append(cert_der)
            if include_root:
                certs.append(self.root_cert.public_bytes(serialization.Encoding.DER))
        signed_data = der.sequence(
            der.integer(3),
            der.set_of(der.algorithm_identifier(tsa.HASH_ALGORITHMS["sha256"])),
            der.sequence(der.oid(tsa.OID_CT_TSTINFO), der.explicit(0, der.octet_string(tst_info))),
            *([der.implicit_constructed(0, b"".join(sorted(certs)))] if certs else []),
            der.set_of(signer_info),
        )
        token = der.sequence(der.oid(tsa.OID_SIGNED_DATA), der.explicit(0, signed_data))
        return der.sequence(der.sequence(der.integer(0)), token)

    # --- PKI-контекст -------------------------------------------------------

    def ocsp_response(self, request_der: bytes) -> bytes:
        request = ocsp.load_der_ocsp_request(request_der)
        now = datetime.now(UTC)
        builder = ocsp.OCSPResponseBuilder().add_response(
            cert=self.cert,
            issuer=self.root_cert,
            algorithm=request.hash_algorithm,
            cert_status=ocsp.OCSPCertStatus.GOOD,
            this_update=now,
            next_update=now + timedelta(days=1),
            revocation_time=None,
            revocation_reason=None,
        )
        builder = builder.responder_id(ocsp.OCSPResponderEncoding.NAME, self.root_cert)
        response = builder.sign(self.root_key, hashes.SHA256())
        return response.public_bytes(serialization.Encoding.DER)

    def crl(self) -> bytes:
        now = datetime.now(UTC)
        crl = (
            x509.CertificateRevocationListBuilder()
            .issuer_name(self.root_cert.subject)
            .last_update(now)
            .next_update(now + timedelta(days=7))
            .sign(self.root_key, hashes.SHA256())
        )
        return crl.public_bytes(serialization.Encoding.DER)

    def root_pem(self) -> bytes:
        return self.root_cert.public_bytes(serialization.Encoding.PEM)

    # --- httpx.MockTransport ----------------------------------------------

    def handle(self, request: httpx.Request, **respond_kwargs: object) -> httpx.Response:
        url = str(request.url)
        if url.startswith(self.ocsp_url):
            return httpx.Response(200, content=self.ocsp_response(request.content))
        if url == self.crl_url:
            return httpx.Response(200, content=self.crl())
        if url == self.ca_issuers_url:
            return httpx.Response(200, content=self.root_pem())
        body = self.respond(request.content, **respond_kwargs)  # type: ignore[arg-type]
        return httpx.Response(200, content=body, headers={"Content-Type": tsa.CONTENT_TYPE_REPLY})


def transport_for(servers: dict[str, FakeTsaServer]) -> httpx.MockTransport:
    """host → сервер; OCSP/CRL/AIA-хосты серверов обслуживаются ими же."""

    def handler(request: httpx.Request) -> httpx.Response:
        host = request.url.host
        for server in servers.values():
            if host in (
                f"ocsp.{server.host}",
                f"crl.{server.host}",
                f"ca.{server.host}",
            ):
                return server.handle(request)
        server = servers.get(host)
        if server is None:
            return httpx.Response(404)
        return server.handle(request)

    return httpx.MockTransport(handler)
