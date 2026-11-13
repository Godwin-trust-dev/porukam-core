"""RFC 3161 (Time-Stamp Protocol) — построение TimeStampReq, разбор
TimeStampResp, ОФЛАЙН-проверка токена и архивация PKI-контекста (цепочка
сертификатов + OCSP/CRL на момент штампования). ADR-135.

Библиотека: только `cryptography` (сертификаты, подписи, OCSP/CRL) поверх
собственного минимального DER (services/audit_vault/der.py) — у
`cryptography` нет RFC 3161/CMS-разбора, `asn1crypto`/`rfc3161ng` в
зависимостях нет и добавлять их ради четырёх запросов в сутки не стали.

Сетевой слой (HTTP POST `application/timestamp-query`, OCSP, AIA) здесь
принимает `httpx.Client` снаружи — в тестах это `httpx.MockTransport`,
сеть в тестах запрещена (CLAUDE.md/ADR-135).

Что проверяет `verify_timestamp_token` (RFC 3161 §2.4.2, RFC 5652 §5.6):
статус granted; messageImprint (алгоритм + хеш) совпадает с ожидаемым;
nonce совпадает; сертификат подписанта найден (в ответе или в архивной
цепочке) и содержит EKU id-kp-timeStamping; signedAttrs содержат
content-type = id-ct-TSTInfo и message-digest = hash(TSTInfo); подпись
SignerInfo сходится с открытым ключом подписанта; genTime — внутри срока
действия сертификата подписанта. Доверие к корню (trust anchor) НЕ
решается здесь — это вопрос экспертизы/`openssl ts -verify -CAfile` при
экспорте пакета (README сервиса). Единственное исключение — ПОЛНОТА
архивной цепочки: она может закрываться совпадением последнего звена
с закреплённым в репозитории якорем (trust_anchors/, ADR-147)."""

from __future__ import annotations

import base64
import hashlib
import logging
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import datetime
from functools import lru_cache
from pathlib import Path
from typing import Any

import httpx
from cryptography import x509
from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec, padding, rsa
from cryptography.hazmat.primitives.asymmetric.types import CertificatePublicKeyTypes
from cryptography.x509 import ocsp
from cryptography.x509.oid import AuthorityInformationAccessOID, ExtendedKeyUsageOID, ExtensionOID

from . import der

logger = logging.getLogger(__name__)

# --- OID'ы -----------------------------------------------------------------
OID_SIGNED_DATA = "1.2.840.113549.1.7.2"
OID_CT_TSTINFO = "1.2.840.113549.1.9.16.1.4"
OID_ATTR_CONTENT_TYPE = "1.2.840.113549.1.9.3"
OID_ATTR_MESSAGE_DIGEST = "1.2.840.113549.1.9.4"
OID_ATTR_SIGNING_CERT = "1.2.840.113549.1.9.16.2.12"  # ESSCertID (sha1)
OID_ATTR_SIGNING_CERT_V2 = "1.2.840.113549.1.9.16.2.47"  # ESSCertIDv2

OID_RSA_ENCRYPTION = "1.2.840.113549.1.1.1"
OID_RSASSA_PSS = "1.2.840.113549.1.1.10"
OID_MGF1 = "1.2.840.113549.1.1.8"
_RSA_WITH_HASH = {
    "1.2.840.113549.1.1.5": "sha1",
    "1.2.840.113549.1.1.14": "sha224",
    "1.2.840.113549.1.1.11": "sha256",
    "1.2.840.113549.1.1.12": "sha384",
    "1.2.840.113549.1.1.13": "sha512",
}
_ECDSA_WITH_HASH = {
    "1.2.840.10045.4.1": "sha1",
    "1.2.840.10045.4.3.1": "sha224",
    "1.2.840.10045.4.3.2": "sha256",
    "1.2.840.10045.4.3.3": "sha384",
    "1.2.840.10045.4.3.4": "sha512",
}

# Алгоритм хеша — ПОЛЕ записи, не константа (ADR-135 п.5): ГОСТ-TSA
# потребует Стрибог (1.2.643.7.1.1.2.2 / .3) — добавляется строкой здесь и
# реализацией хеша, формат записи чекпойнта не меняется.
HASH_ALGORITHMS: dict[str, str] = {
    "sha1": "1.3.14.3.2.26",
    "sha224": "2.16.840.1.101.3.4.2.4",
    "sha256": "2.16.840.1.101.3.4.2.1",
    "sha384": "2.16.840.1.101.3.4.2.2",
    "sha512": "2.16.840.1.101.3.4.2.3",
}
_OID_TO_HASH = {oid: name for name, oid in HASH_ALGORITHMS.items()}
_CRYPTOGRAPHY_HASHES: dict[str, type[hashes.HashAlgorithm]] = {
    "sha1": hashes.SHA1,
    "sha224": hashes.SHA224,
    "sha256": hashes.SHA256,
    "sha384": hashes.SHA384,
    "sha512": hashes.SHA512,
}

PKI_STATUS = {
    0: "granted",
    1: "grantedWithMods",
    2: "rejection",
    3: "waiting",
    4: "revocationWarning",
    5: "revocationNotification",
}

CONTENT_TYPE_QUERY = "application/timestamp-query"
CONTENT_TYPE_REPLY = "application/timestamp-reply"


class TsaError(Exception):
    """Ответ TSA не принят (сеть, статус, проверка токена)."""


def hash_name_from_oid(dotted: str) -> str:
    try:
        return _OID_TO_HASH[dotted]
    except KeyError as exc:
        raise TsaError(f"неизвестный алгоритм хеша {dotted}") from exc


def _hash_algorithm(name: str) -> hashes.HashAlgorithm:
    try:
        return _CRYPTOGRAPHY_HASHES[name]()
    except KeyError as exc:
        raise TsaError(f"алгоритм {name} не поддерживается этой сборкой") from exc


def digest_bytes(name: str, data: bytes) -> bytes:
    return hashlib.new(name, data).digest()


# ---------------------------------------------------------------------------
# TimeStampReq
# ---------------------------------------------------------------------------


def build_timestamp_request(
    message_imprint: bytes, *, alg: str = "sha256", nonce: int, cert_req: bool = True
) -> bytes:
    """TimeStampReq (RFC 3161 §2.4.1): version 1, messageImprint, nonce,
    certReq. reqPolicy не задаём — TSA сам выбирает политику по умолчанию."""
    if alg not in HASH_ALGORITHMS:
        raise TsaError(f"неизвестный алгоритм хеша {alg}")
    expected_len = hashlib.new(alg).digest_size
    if len(message_imprint) != expected_len:
        raise TsaError(f"длина imprint {len(message_imprint)} не соответствует {alg}")
    if nonce <= 0:
        raise TsaError("nonce должен быть положительным")
    return der.sequence(
        der.integer(1),
        der.sequence(
            der.algorithm_identifier(HASH_ALGORITHMS[alg]),
            der.octet_string(message_imprint),
        ),
        der.integer(nonce),
        der.boolean(cert_req),
    )


@dataclass(frozen=True, slots=True)
class TimestampRequest:
    alg: str
    message_imprint: bytes
    nonce: int | None
    cert_req: bool


def parse_timestamp_request(data: bytes) -> TimestampRequest:
    parts = der.expect(der.decode(data), der.SEQUENCE, "TimeStampReq").children()
    if len(parts) < 2 or der.decode_integer(parts[0]) != 1:
        raise TsaError("TimeStampReq: не version 1")
    alg, imprint = _parse_message_imprint(parts[1])
    nonce: int | None = None
    cert_req = False
    for node in parts[2:]:
        if node.tag == der.INTEGER:
            nonce = der.decode_integer(node)
        elif node.tag == der.BOOLEAN:
            cert_req = der.decode_boolean(node)
    return TimestampRequest(alg=alg, message_imprint=imprint, nonce=nonce, cert_req=cert_req)


def _parse_message_imprint(node: der.Node) -> tuple[str, bytes]:
    parts = der.expect(node, der.SEQUENCE, "MessageImprint").children()
    if len(parts) != 2:
        raise TsaError("MessageImprint: ожидались hashAlgorithm и hashedMessage")
    alg = hash_name_from_oid(der.decode_algorithm_identifier(parts[0]))
    return alg, der.expect(parts[1], der.OCTET_STRING, "hashedMessage").content


# ---------------------------------------------------------------------------
# TimeStampResp
# ---------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class TstInfo:
    policy: str
    alg: str
    message_imprint: bytes
    serial: int
    gen_time: datetime
    nonce: int | None
    tsa_name: str | None
    raw: bytes  # DER TSTInfo — то, что хешируется в message-digest


@dataclass(frozen=True, slots=True)
class SignerInfo:
    digest_alg: str
    signature_alg: str
    signature_params: der.Node | None
    signed_attrs: der.Node  # [0] IMPLICIT SET OF Attribute (как в ответе)
    signature: bytes
    issuer_der: bytes | None
    serial: int | None
    subject_key_id: bytes | None


@dataclass(frozen=True, slots=True)
class TimestampResponse:
    status: int
    status_text: str
    status_strings: tuple[str, ...]
    tst_info: TstInfo | None
    signer: SignerInfo | None
    certificates: tuple[x509.Certificate, ...]

    @property
    def granted(self) -> bool:
        return self.status in (0, 1)


def parse_timestamp_response(data: bytes) -> TimestampResponse:
    parts = der.expect(der.decode(data), der.SEQUENCE, "TimeStampResp").children()
    if not parts:
        raise TsaError("TimeStampResp пуст")
    status, strings = _parse_status(parts[0])
    if len(parts) < 2:
        return TimestampResponse(
            status, PKI_STATUS.get(status, str(status)), strings, None, None, ()
        )
    tst_info, signer, certs = _parse_token(parts[1])
    return TimestampResponse(
        status=status,
        status_text=PKI_STATUS.get(status, str(status)),
        status_strings=strings,
        tst_info=tst_info,
        signer=signer,
        certificates=certs,
    )


def _parse_status(node: der.Node) -> tuple[int, tuple[str, ...]]:
    parts = der.expect(node, der.SEQUENCE, "PKIStatusInfo").children()
    if not parts:
        raise TsaError("PKIStatusInfo пуст")
    status = der.decode_integer(parts[0])
    strings: list[str] = []
    for extra in parts[1:]:
        if extra.tag == der.SEQUENCE:  # PKIFreeText ::= SEQUENCE OF UTF8String
            strings.extend(
                child.content.decode("utf-8", "replace")
                for child in extra.children()
                if child.tag == der.UTF8_STRING
            )
    return status, tuple(strings)


def _parse_token(node: der.Node) -> tuple[TstInfo, SignerInfo, tuple[x509.Certificate, ...]]:
    content_info = der.expect(node, der.SEQUENCE, "ContentInfo").children()
    if len(content_info) != 2 or der.decode_oid(content_info[0]) != OID_SIGNED_DATA:
        raise TsaError("TimeStampToken: ожидался ContentInfo(signedData)")
    signed_data_node = der.expect(content_info[1], der.CONTEXT_CONSTRUCTED, "[0] content")
    signed_data = der.expect(der.decode(signed_data_node.content), der.SEQUENCE, "SignedData")
    parts = signed_data.children()
    if len(parts) < 4:
        raise TsaError("SignedData: слишком мало элементов")
    # version, digestAlgorithms, encapContentInfo, [certificates], [crls], signerInfos
    encap = der.expect(parts[2], der.SEQUENCE, "EncapsulatedContentInfo").children()
    if len(encap) != 2 or der.decode_oid(encap[0]) != OID_CT_TSTINFO:
        raise TsaError("SignedData: eContentType не id-ct-TSTInfo")
    e_content = der.expect(der.decode(encap[1].content), der.OCTET_STRING, "eContent")
    tst_info = _parse_tst_info(e_content.content)

    certificates: list[x509.Certificate] = []
    signer_infos: der.Node | None = None
    for extra in parts[3:]:
        if extra.context_number == 0:
            for choice in extra.children():
                if choice.tag == der.SEQUENCE:  # CertificateChoices: только Certificate
                    certificates.append(x509.load_der_x509_certificate(choice.raw))
        elif extra.tag == der.SET:
            signer_infos = extra
    if signer_infos is None:
        raise TsaError("SignedData без signerInfos")
    signers = signer_infos.children()
    if len(signers) != 1:
        raise TsaError(f"ожидался ровно один SignerInfo, получено {len(signers)}")
    return tst_info, _parse_signer_info(signers[0]), tuple(certificates)


def _parse_tst_info(raw: bytes) -> TstInfo:
    parts = der.expect(der.decode(raw), der.SEQUENCE, "TSTInfo").children()
    if len(parts) < 5 or der.decode_integer(parts[0]) != 1:
        raise TsaError("TSTInfo: не version 1")
    policy = der.decode_oid(parts[1])
    alg, imprint = _parse_message_imprint(parts[2])
    serial = der.decode_integer(parts[3])
    gen_time = der.decode_generalized_time(parts[4])
    nonce: int | None = None
    tsa_name: str | None = None
    for node in parts[5:]:
        if node.tag == der.INTEGER:
            nonce = der.decode_integer(node)
        elif node.context_number == 0 and node.constructed:
            tsa_name = _general_name(node)
    return TstInfo(
        policy=policy,
        alg=alg,
        message_imprint=imprint,
        serial=serial,
        gen_time=gen_time,
        nonce=nonce,
        tsa_name=tsa_name,
        raw=raw,
    )


def _general_name(node: der.Node) -> str | None:
    """tsa [0] GeneralName — интересует только directoryName [4]; имя
    информационное (в записи чекпойнта фиксируется subject сертификата
    подписанта), поэтому любой сбой разбора — None, не ошибка."""
    try:
        (choice,) = node.children()
        if choice.context_number != 4 or not choice.constructed:
            return None
        return _name_from_der(choice.content).rfc4514_string()
    except (ValueError, der.DerError):
        return None


def _name_from_der(name_der: bytes) -> x509.Name:
    """Name ::= SEQUENCE OF RelativeDistinguishedName (SET OF AttributeTypeAndValue)."""
    rdns: list[x509.RelativeDistinguishedName] = []
    for rdn in der.expect(der.decode(name_der), der.SEQUENCE, "Name").children():
        attributes: list[x509.NameAttribute[str | bytes]] = []
        for atv in rdn.children():
            atv_type, atv_value = atv.children()
            attributes.append(
                x509.NameAttribute(
                    x509.ObjectIdentifier(der.decode_oid(atv_type)),
                    atv_value.content.decode("utf-8", "replace"),
                )
            )
        rdns.append(x509.RelativeDistinguishedName(attributes))
    return x509.Name(rdns)


def _parse_signer_info(node: der.Node) -> SignerInfo:
    parts = der.expect(node, der.SEQUENCE, "SignerInfo").children()
    if len(parts) < 5:
        raise TsaError("SignerInfo: слишком мало элементов")
    version = der.decode_integer(parts[0])
    sid = parts[1]
    issuer_der: bytes | None = None
    serial: int | None = None
    subject_key_id: bytes | None = None
    if version == 1 and sid.tag == der.SEQUENCE:
        issuer_node, serial_node = sid.children()
        issuer_der = issuer_node.raw
        serial = der.decode_integer(serial_node)
    elif sid.context_number == 0:
        subject_key_id = sid.content
    else:
        raise TsaError("SignerInfo: неизвестный SignerIdentifier")
    digest_alg = hash_name_from_oid(der.decode_algorithm_identifier(parts[2]))
    signed_attrs = parts[3]
    if signed_attrs.context_number != 0:
        raise TsaError("SignerInfo без signedAttrs — для TSTInfo они обязательны")
    sig_alg_node = der.expect(parts[4], der.SEQUENCE, "signatureAlgorithm")
    sig_alg_parts = sig_alg_node.children()
    signature_alg = der.decode_oid(sig_alg_parts[0])
    signature_params = sig_alg_parts[1] if len(sig_alg_parts) > 1 else None
    signature = der.expect(parts[5], der.OCTET_STRING, "signature").content
    return SignerInfo(
        digest_alg=digest_alg,
        signature_alg=signature_alg,
        signature_params=signature_params,
        signed_attrs=signed_attrs,
        signature=signature,
        issuer_der=issuer_der,
        serial=serial,
        subject_key_id=subject_key_id,
    )


# ---------------------------------------------------------------------------
# Проверка токена (офлайн)
# ---------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class TokenVerification:
    ok: bool
    errors: tuple[str, ...]
    response: TimestampResponse
    signer_certificate: x509.Certificate | None


def find_signer_certificate(
    signer: SignerInfo, candidates: list[x509.Certificate]
) -> x509.Certificate | None:
    for cert in candidates:
        if signer.issuer_der is not None:
            if (
                cert.issuer.public_bytes() == signer.issuer_der
                and cert.serial_number == signer.serial
            ):
                return cert
        elif signer.subject_key_id is not None:
            try:
                ski = cert.extensions.get_extension_for_oid(ExtensionOID.SUBJECT_KEY_IDENTIFIER)
            except x509.ExtensionNotFound:
                continue
            value = ski.value
            if (
                isinstance(value, x509.SubjectKeyIdentifier)
                and value.digest == signer.subject_key_id
            ):
                return cert
    return None


def _signed_attributes(signed_attrs: der.Node) -> dict[str, list[der.Node]]:
    attrs: dict[str, list[der.Node]] = {}
    for attribute in signed_attrs.children():
        parts = der.expect(attribute, der.SEQUENCE, "Attribute").children()
        if len(parts) != 2:
            raise TsaError("Attribute: ожидались attrType и attrValues")
        attrs[der.decode_oid(parts[0])] = parts[1].children()
    return attrs


def _verify_signature(
    public_key: CertificatePublicKeyTypes, signer: SignerInfo, signed_bytes: bytes
) -> None:
    alg = signer.signature_alg
    if isinstance(public_key, rsa.RSAPublicKey):
        if alg == OID_RSA_ENCRYPTION:
            public_key.verify(
                signer.signature,
                signed_bytes,
                padding.PKCS1v15(),
                _hash_algorithm(signer.digest_alg),
            )
        elif alg in _RSA_WITH_HASH:
            public_key.verify(
                signer.signature,
                signed_bytes,
                padding.PKCS1v15(),
                _hash_algorithm(_RSA_WITH_HASH[alg]),
            )
        elif alg == OID_RSASSA_PSS:
            hash_name, salt_length = _parse_pss_params(signer.signature_params)
            hash_alg = _hash_algorithm(hash_name)
            public_key.verify(
                signer.signature,
                signed_bytes,
                padding.PSS(mgf=padding.MGF1(hash_alg), salt_length=salt_length),
                hash_alg,
            )
        else:
            raise TsaError(f"неподдерживаемый алгоритм подписи RSA {alg}")
    elif isinstance(public_key, ec.EllipticCurvePublicKey):
        if alg not in _ECDSA_WITH_HASH:
            raise TsaError(f"неподдерживаемый алгоритм подписи ECDSA {alg}")
        public_key.verify(
            signer.signature, signed_bytes, ec.ECDSA(_hash_algorithm(_ECDSA_WITH_HASH[alg]))
        )
    else:
        raise TsaError(f"неподдерживаемый тип ключа подписанта {type(public_key).__name__}")


def _parse_pss_params(params: der.Node | None) -> tuple[str, int]:
    """RSASSA-PSS-params (RFC 4055 §3.1): по умолчанию sha1/MGF1-sha1/salt 20."""
    hash_name = "sha1"
    salt_length = 20
    if params is None or params.tag != der.SEQUENCE:
        return hash_name, salt_length
    for part in params.children():
        number = part.context_number
        if number == 0:
            hash_name = hash_name_from_oid(
                der.decode_algorithm_identifier(der.decode(part.content))
            )
        elif number == 2:
            salt_length = der.decode_integer(der.decode(part.content))
    return hash_name, salt_length


def _check_ess_signing_certificate(
    attrs: dict[str, list[der.Node]], cert: x509.Certificate
) -> str | None:
    """RFC 3161 §2.4.2: signingCertificate(V2) в signedAttrs обязателен и
    должен указывать на сертификат подписанта (хеш DER сертификата)."""
    cert_der = cert.public_bytes(serialization.Encoding.DER)
    for attr_oid, default_hash in (
        (OID_ATTR_SIGNING_CERT_V2, "sha256"),
        (OID_ATTR_SIGNING_CERT, "sha1"),
    ):
        values = attrs.get(attr_oid)
        if not values:
            continue
        try:
            certs_seq = der.expect(values[0], der.SEQUENCE, "SigningCertificate").children()[0]
            for ess_cert_id in certs_seq.children():
                parts = ess_cert_id.children()
                hash_name = default_hash
                if parts and parts[0].tag == der.SEQUENCE:
                    hash_name = hash_name_from_oid(der.decode_algorithm_identifier(parts[0]))
                    parts = parts[1:]
                if parts and parts[0].content == digest_bytes(hash_name, cert_der):
                    return None
        except (der.DerError, TsaError, IndexError):
            return "signedAttrs: ESSCertID не разбирается"
        return "signedAttrs: ESSCertID не соответствует сертификату подписанта"
    return "signedAttrs: нет signingCertificate/signingCertificateV2 (RFC 3161 §2.4.2)"


def verify_timestamp_token(
    tsr: bytes,
    *,
    message_imprint: bytes,
    alg: str,
    nonce: int | None,
    extra_certificates: list[x509.Certificate] | None = None,
) -> TokenVerification:
    """Офлайн-проверка ответа TSA (см. докстринг модуля). Не бросает при
    несоответствиях — собирает `errors`, чтобы отчёт экспертизы показал все
    расхождения сразу; бросает `TsaError` только на нечитаемом DER."""
    errors: list[str] = []
    try:
        response = parse_timestamp_response(tsr)
    except der.DerError as exc:
        raise TsaError(f"TimeStampResp не разбирается: {exc}") from exc

    if not response.granted:
        errors.append(
            f"статус {response.status_text}"
            + (f": {'; '.join(response.status_strings)}" if response.status_strings else "")
        )
    if response.tst_info is None or response.signer is None:
        errors.append("ответ без TimeStampToken")
        return TokenVerification(False, tuple(errors), response, None)

    info = response.tst_info
    signer = response.signer
    if info.alg != alg:
        errors.append(f"алгоритм messageImprint {info.alg}, ожидался {alg}")
    if info.message_imprint != message_imprint:
        errors.append("messageImprint не совпадает с хешем чекпойнта")
    if nonce is not None and info.nonce != nonce:
        errors.append(
            "nonce не совпадает"
            if info.nonce is not None
            else "TSA не вернул nonce (возможен кеш/подмена)"
        )

    candidates = list(response.certificates) + list(extra_certificates or [])
    cert = find_signer_certificate(signer, candidates)
    if cert is None:
        errors.append("сертификат подписанта не найден ни в ответе, ни в архивной цепочке")
        return TokenVerification(False, tuple(errors), response, None)

    try:
        eku = cert.extensions.get_extension_for_oid(ExtensionOID.EXTENDED_KEY_USAGE)
        eku_value = eku.value
        if (
            not isinstance(eku_value, x509.ExtendedKeyUsage)
            or ExtendedKeyUsageOID.TIME_STAMPING not in eku_value
        ):
            errors.append("сертификат подписанта без EKU id-kp-timeStamping")
    except x509.ExtensionNotFound:
        errors.append("сертификат подписанта без EKU (RFC 3161 §2.3 требует timeStamping)")

    if not (cert.not_valid_before_utc <= info.gen_time <= cert.not_valid_after_utc):
        errors.append("genTime вне срока действия сертификата подписанта")

    try:
        attrs = _signed_attributes(signer.signed_attrs)
        content_type = attrs.get(OID_ATTR_CONTENT_TYPE)
        if not content_type or der.decode_oid(content_type[0]) != OID_CT_TSTINFO:
            errors.append("signedAttrs: content-type не id-ct-TSTInfo")
        message_digest = attrs.get(OID_ATTR_MESSAGE_DIGEST)
        if not message_digest or message_digest[0].content != digest_bytes(
            signer.digest_alg, info.raw
        ):
            errors.append("signedAttrs: message-digest не совпадает с хешем TSTInfo")
        ess_error = _check_ess_signing_certificate(attrs, cert)
        if ess_error is not None:
            errors.append(ess_error)
    except der.DerError as exc:
        errors.append(f"signedAttrs не разбираются: {exc}")

    # Подписывается DER signedAttrs с тегом SET (0x31) вместо [0] IMPLICIT (0xA0), RFC 5652 §5.4.
    signed_bytes = bytes([der.SET]) + signer.signed_attrs.raw[1:]
    try:
        _verify_signature(cert.public_key(), signer, signed_bytes)
    except InvalidSignature:
        errors.append("подпись SignerInfo не сходится с ключом сертификата подписанта")
    except TsaError as exc:
        errors.append(str(exc))

    return TokenVerification(not errors, tuple(errors), response, cert)


# ---------------------------------------------------------------------------
# Цепочка сертификатов и статус отзыва на момент штампования (ADR-135 п.3)
# ---------------------------------------------------------------------------


def certificate_to_pem(cert: x509.Certificate) -> str:
    return cert.public_bytes(serialization.Encoding.PEM).decode("ascii")


def certificates_from_pem(chain_pem: list[str]) -> list[x509.Certificate]:
    return [x509.load_pem_x509_certificate(pem.encode("ascii")) for pem in chain_pem]


# --- Якоря доверия (ADR-147) -----------------------------------------------
# Каталог закреплённых корней рядом с модулем: DER/PEM-файлы, происхождение и
# отпечатки — в trust_anchors/README.md. Пиновка — осознанное действие в PR.
TRUST_ANCHORS_DIR = Path(__file__).parent / "trust_anchors"


def _spki_der(cert: x509.Certificate) -> bytes:
    """SubjectPublicKeyInfo сертификата, DER — побайтное сравнение ключей."""
    return cert.public_key().public_bytes(
        serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo
    )


@lru_cache(maxsize=1)
def _trust_anchor_identities() -> frozenset[tuple[bytes, bytes]]:
    """Пары (subject DER, SPKI DER) закреплённых якорей. Кешируется на процесс:
    каталог меняется только коммитом в репозиторий."""
    identities: set[tuple[bytes, bytes]] = set()
    for path in sorted(TRUST_ANCHORS_DIR.glob("*.der")) + sorted(TRUST_ANCHORS_DIR.glob("*.pem")):
        data = path.read_bytes()
        anchor = (
            x509.load_pem_x509_certificate(data)
            if data.lstrip().startswith(b"-----BEGIN")
            else x509.load_der_x509_certificate(data)
        )
        identities.add((anchor.subject.public_bytes(), _spki_der(anchor)))
    return frozenset(identities)


def _matches_trust_anchor(cert: x509.Certificate) -> bool:
    """Совпадение с якорем по subject + SubjectPublicKeyInfo (побайтно, ADR-147)."""
    return (cert.subject.public_bytes(), _spki_der(cert)) in _trust_anchor_identities()


def _closes_chain(cert: x509.Certificate) -> bool:
    """Гибридное правило полноты цепочки (ADR-147, миграционная форма):
    (а) последнее звено совпадает с закреплённым якорем — проверка самоподписи
    НЕ выполняется вовсе, поэтому SHA-1-самоподпись старых корней (Certum 2008)
    в доказательном контуре не участвует; ИЛИ (б) прежнее правило — звено
    самоподписано и подпись проверяется библиотекой современным алгоритмом
    (статус-кво для корней, которые пока не запинованы). По мере пиновки
    остальных корней путь (б) отмирает — см. ADR-147."""
    return _matches_trust_anchor(cert) or _is_self_signed(cert)


def _is_self_signed(cert: x509.Certificate) -> bool:
    if cert.issuer != cert.subject:
        return False
    try:
        cert.verify_directly_issued_by(cert)
    except (InvalidSignature, ValueError, TypeError):
        return False
    return True


def _find_issuer(cert: x509.Certificate, pool: list[x509.Certificate]) -> x509.Certificate | None:
    for candidate in pool:
        if candidate.subject != cert.issuer or candidate is cert:
            continue
        try:
            cert.verify_directly_issued_by(candidate)
        except (InvalidSignature, ValueError, TypeError):
            continue
        return candidate
    return None


def _aia_urls(cert: x509.Certificate, method: x509.ObjectIdentifier) -> list[str]:
    try:
        aia = cert.extensions.get_extension_for_oid(ExtensionOID.AUTHORITY_INFORMATION_ACCESS).value
    except x509.ExtensionNotFound:
        return []
    if not isinstance(aia, x509.AuthorityInformationAccess):
        return []
    return [
        desc.access_location.value
        for desc in aia
        if desc.access_method == method
        and isinstance(desc.access_location, x509.UniformResourceIdentifier)
    ]


def _crl_urls(cert: x509.Certificate) -> list[str]:
    try:
        cdp = cert.extensions.get_extension_for_oid(ExtensionOID.CRL_DISTRIBUTION_POINTS).value
    except x509.ExtensionNotFound:
        return []
    urls: list[str] = []
    if isinstance(cdp, x509.CRLDistributionPoints):
        for point in cdp:
            for name in point.full_name or []:
                if isinstance(name, x509.UniformResourceIdentifier) and name.value.startswith(
                    "http"
                ):
                    urls.append(name.value)
    return urls


def _load_certificate_any(body: bytes) -> x509.Certificate | None:
    if body.lstrip().startswith(b"-----BEGIN"):
        return x509.load_pem_x509_certificate(body)
    try:
        return x509.load_der_x509_certificate(body)
    except ValueError:
        pass
    # PKCS#7 (.p7c) — берём первый сертификат; ContentInfo(signedData).certificates
    try:
        _, _, certs = _parse_pkcs7_certificates(body)
        return certs[0] if certs else None
    except (der.DerError, TsaError, IndexError):
        return None


def _parse_pkcs7_certificates(body: bytes) -> tuple[None, None, list[x509.Certificate]]:
    content_info = der.expect(der.decode(body), der.SEQUENCE, "ContentInfo").children()
    signed_data = der.expect(der.decode(content_info[1].content), der.SEQUENCE, "SignedData")
    certs: list[x509.Certificate] = []
    for extra in signed_data.children()[3:]:
        if extra.context_number == 0:
            certs.extend(
                x509.load_der_x509_certificate(choice.raw)
                for choice in extra.children()
                if choice.tag == der.SEQUENCE
            )
    return None, None, certs


def build_certificate_chain(
    signer: x509.Certificate,
    pool: list[x509.Certificate],
    *,
    client: httpx.Client | None = None,
    max_fetches: int = 4,
) -> tuple[list[x509.Certificate], bool]:
    """Упорядоченная цепочка от подписанта вверх. Недостающие звенья
    докачиваются по AIA caIssuers (если дан `client`), ограниченно.
    Возвращает (цепочка, полная_ли) — полнота по гибридному правилу
    `_closes_chain` (якорь ADR-147 либо самоподписанный корень)."""
    chain = [signer]
    pool = [c for c in pool if c is not signer]
    fetches = 0
    current = signer
    while not _closes_chain(current) and len(chain) < 10:
        issuer = _find_issuer(current, pool)
        if issuer is None and client is not None and fetches < max_fetches:
            for url in _aia_urls(current, AuthorityInformationAccessOID.CA_ISSUERS):
                fetches += 1
                fetched = _fetch_certificate(client, url)
                if fetched is not None and _find_issuer(current, [fetched]) is fetched:
                    issuer = fetched
                    break
                if fetches >= max_fetches:
                    break
        if issuer is None:
            return chain, False
        chain.append(issuer)
        pool = [c for c in pool if c is not issuer]
        current = issuer
    return chain, _closes_chain(current)


def _fetch_certificate(client: httpx.Client, url: str) -> x509.Certificate | None:
    try:
        response = client.get(url)
        response.raise_for_status()
        return _load_certificate_any(response.content)
    except (httpx.HTTPError, ValueError) as exc:
        logger.warning(
            "tsa: не удалось получить сертификат издателя по AIA",
            extra={"url": url, "error": str(exc)},
        )
        return None


def collect_revocation(
    cert: x509.Certificate, issuer: x509.Certificate | None, *, client: httpx.Client
) -> dict[str, Any] | None:
    """Статус отзыва сертификата подписанта НА МОМЕНТ штампования: сначала
    OCSP по AIA (нужен сертификат издателя), иначе CRL по CDP, иначе None
    (вызывающий код пишет warning: через годы статус будет не восстановить)."""
    if issuer is not None:
        for url in _aia_urls(cert, AuthorityInformationAccessOID.OCSP):
            result = _ocsp(cert, issuer, url, client)
            if result is not None:
                return result
    for url in _crl_urls(cert):
        result = _crl(cert, url, client)
        if result is not None:
            return result
    return None


def _ocsp(
    cert: x509.Certificate, issuer: x509.Certificate, url: str, client: httpx.Client
) -> dict[str, Any] | None:
    try:
        request = ocsp.OCSPRequestBuilder().add_certificate(cert, issuer, hashes.SHA1()).build()
        response = client.post(
            url,
            content=request.public_bytes(serialization.Encoding.DER),
            headers={"Content-Type": "application/ocsp-request"},
        )
        response.raise_for_status()
        parsed = ocsp.load_der_ocsp_response(response.content)
        if parsed.response_status != ocsp.OCSPResponseStatus.SUCCESSFUL:
            logger.warning(
                "tsa: OCSP-ответчик вернул не SUCCESSFUL",
                extra={"url": url, "status": str(parsed.response_status)},
            )
            return None
        single = next(iter(parsed.responses))
        return {
            "kind": "ocsp",
            "url": url,
            "der_b64": base64.b64encode(response.content).decode("ascii"),
            "status": single.certificate_status.name.lower(),
            "produced_at": parsed.produced_at_utc.isoformat(),
            "this_update": single.this_update_utc.isoformat(),
            "next_update": single.next_update_utc.isoformat() if single.next_update_utc else None,
        }
    except (httpx.HTTPError, ValueError, StopIteration) as exc:
        logger.warning("tsa: OCSP-запрос не удался", extra={"url": url, "error": str(exc)})
        return None


def _crl(cert: x509.Certificate, url: str, client: httpx.Client) -> dict[str, Any] | None:
    try:
        response = client.get(url)
        response.raise_for_status()
        body = response.content
        crl = (
            x509.load_pem_x509_crl(body)
            if body.lstrip().startswith(b"-----BEGIN")
            else x509.load_der_x509_crl(body)
        )
        revoked = crl.get_revoked_certificate_by_serial_number(cert.serial_number)
        return {
            "kind": "crl",
            "url": url,
            "der_b64": base64.b64encode(crl.public_bytes(serialization.Encoding.DER)).decode(
                "ascii"
            ),
            "status": "revoked" if revoked is not None else "good",
            "this_update": crl.last_update_utc.isoformat(),
            "next_update": crl.next_update_utc.isoformat() if crl.next_update_utc else None,
        }
    except (httpx.HTTPError, ValueError) as exc:
        logger.warning("tsa: CRL не получен", extra={"url": url, "error": str(exc)})
        return None


# ---------------------------------------------------------------------------
# Один запрос к одному TSA
# ---------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class TimestampRecord:
    """Один слой метки на чекпойнт (ADR-135: формат допускает несколько
    слоёв — rollover в будущем добавит записи в тот же список)."""

    tsa: str
    alg: str
    nonce: int
    tsq_b64: str
    tsr_b64: str
    gen_time: datetime
    serial: int
    policy: str
    signer: str
    chain_pem: list[str]
    chain_complete: bool
    revocation: dict[str, Any] | None
    requested_at: datetime
    latency_ms: int
    warnings: list[str] = field(default_factory=list)

    def as_json(self) -> dict[str, Any]:
        return {
            "tsa": self.tsa,
            "alg": self.alg,
            "nonce": hex(self.nonce),
            "tsq_b64": self.tsq_b64,
            "tsr_b64": self.tsr_b64,
            "gen_time": self.gen_time.isoformat(),
            "serial": hex(self.serial),
            "policy": self.policy,
            "signer": self.signer,
            "chain_pem": list(self.chain_pem),
            "chain_complete": self.chain_complete,
            "revocation": self.revocation,
            "requested_at": self.requested_at.isoformat(),
            "latency_ms": self.latency_ms,
            "warnings": list(self.warnings),
        }


def request_timestamp(
    url: str,
    message_imprint: bytes,
    *,
    alg: str,
    nonce: int,
    client: httpx.Client,
    now: Callable[[], datetime],
    archive_pki: bool = True,
) -> TimestampRecord:
    """POST TimeStampReq → проверенный TimestampRecord либо TsaError."""
    tsq = build_timestamp_request(message_imprint, alg=alg, nonce=nonce, cert_req=True)
    requested_at = now()
    try:
        response = client.post(
            url,
            content=tsq,
            headers={"Content-Type": CONTENT_TYPE_QUERY, "Accept": CONTENT_TYPE_REPLY},
        )
    except httpx.TimeoutException as exc:
        raise TsaError(f"timeout: {exc}") from exc
    except httpx.HTTPError as exc:
        raise TsaError(f"http: {exc}") from exc
    latency_ms = int((now() - requested_at).total_seconds() * 1000)
    if response.status_code != 200:
        raise TsaError(f"http {response.status_code}")
    warnings: list[str] = []
    if CONTENT_TYPE_REPLY not in response.headers.get("content-type", ""):
        warnings.append(f"content-type ответа: {response.headers.get('content-type', '')!r}")

    verification = verify_timestamp_token(
        response.content, message_imprint=message_imprint, alg=alg, nonce=nonce
    )
    if not verification.ok or verification.signer_certificate is None:
        raise TsaError("; ".join(verification.errors) or "токен не прошёл проверку")
    info = verification.response.tst_info
    assert info is not None  # verify_timestamp_token гарантирует при ok
    signer_cert = verification.signer_certificate

    chain, complete = build_certificate_chain(
        signer_cert,
        list(verification.response.certificates),
        client=client if archive_pki else None,
    )
    if not complete:
        warnings.append("цепочка не доведена до доверенного корня (якорь или самоподписанный)")
    revocation: dict[str, Any] | None = None
    if archive_pki:
        revocation = collect_revocation(
            signer_cert, chain[1] if len(chain) > 1 else None, client=client
        )
        if revocation is None:
            warnings.append("статус отзыва (OCSP/CRL) на момент штампования не получен")
            logger.warning(
                "tsa: без OCSP/CRL для подписанта",
                extra={"tsa": url, "signer": signer_cert.subject.rfc4514_string()},
            )

    return TimestampRecord(
        tsa=url,
        alg=alg,
        nonce=nonce,
        tsq_b64=base64.b64encode(tsq).decode("ascii"),
        tsr_b64=base64.b64encode(response.content).decode("ascii"),
        gen_time=info.gen_time,
        serial=info.serial,
        policy=info.policy,
        signer=signer_cert.subject.rfc4514_string(),
        chain_pem=[certificate_to_pem(c) for c in chain],
        chain_complete=complete,
        revocation=revocation,
        requested_at=requested_at,
        latency_ms=latency_ms,
        warnings=warnings,
    )


def verify_chain_links(chain: list[x509.Certificate]) -> tuple[bool, list[str]]:
    """Каждое звено архивной цепочки подписано следующим; последнее закрывает
    цепочку по гибридному правилу `_closes_chain` (якорь ADR-147 либо
    самоподписанный корень). Подписи промежуточных звеньев проверяются всегда —
    якорь освобождает только от проверки самоподписи последнего звена."""
    errors: list[str] = []
    for index in range(len(chain) - 1):
        subject = chain[index].subject.rfc4514_string()
        issuer = chain[index + 1].subject.rfc4514_string()
        try:
            chain[index].verify_directly_issued_by(chain[index + 1])
        except (InvalidSignature, ValueError, TypeError) as exc:
            errors.append(f"звено {index}: {subject} не выпущен {issuer} ({exc})")
    if chain and not _closes_chain(chain[-1]):
        errors.append(
            "цепочка не завершается доверенным корнем (ни якорь ADR-147, ни самоподписанный)"
        )
    return not errors, errors
