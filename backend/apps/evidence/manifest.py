"""Манифест DeviceKey (tech-spec.md §8.9 `POST /evidence/batches`, ADR-053
п.2, ADR-136 п.6) — чистые функции без Django/БД: разбор, каноническая
форма, проверка подписи. Кто подписывал и действовало ли назначение — в
`apps.evidence.services.verify_device_manifest` (там БД: DeviceKey,
ContractAssignment через фасад apps.authority).

Каноническая форма — JSON с сортированными ключами, без пробелов, ASCII
(тот же приём, что `services/audit_vault/canonical.py`): телефон подписывает
РОВНО эти байты. Подписывается манифест целиком, включая `sha256` файла —
так подпись покрывает и содержимое, и метаданные момента съёмки.

Алгоритмы: `ed25519` (сырой 32-байтовый публичный ключ) и `ecdsa_p256`
(Secure Enclave/Keystore: SubjectPublicKeyInfo DER, ECDSA-SHA256, DER-
подпись). Что именно даст Р1-мобайл — решится в Э10; оба варианта дёшевы
и покрыты тестами, чтобы серверная половина не стала блокером."""

from __future__ import annotations

import json
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import datetime
from typing import Any
from uuid import UUID

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

ALGORITHM_ED25519 = "ed25519"
ALGORITHM_ECDSA_P256 = "ecdsa_p256"
SUPPORTED_ALGORITHMS = frozenset({ALGORITHM_ED25519, ALGORITHM_ECDSA_P256})


class DeviceManifestError(ValueError):
    """Манифест не разбирается (нет обязательного поля, неверный тип)."""


@dataclass(frozen=True, slots=True)
class DeviceManifest:
    sha256: str
    captured_at_device: datetime
    contract_id: UUID
    device_key_id: int
    milestone_id: UUID | None
    checklist_item_id: UUID | None
    assignment_id: UUID | None
    geo: dict[str, float] | None
    clock_skew_ms: int | None


def canonical_manifest_bytes(raw: Mapping[str, Any]) -> bytes:
    return json.dumps(dict(raw), sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode(
        "ascii"
    )


def _uuid(raw: Mapping[str, Any], key: str, *, required: bool) -> UUID | None:
    value = raw.get(key)
    if value in (None, ""):
        if required:
            raise DeviceManifestError(f"манифест без обязательного поля {key!r}")
        return None
    try:
        return UUID(str(value))
    except ValueError as exc:
        raise DeviceManifestError(f"манифест: {key!r} не UUID") from exc


def _geo(raw: Mapping[str, Any]) -> dict[str, float] | None:
    value = raw.get("geo")
    if value is None:
        return None
    if not isinstance(value, Mapping) or "lat" not in value or "lon" not in value:
        raise DeviceManifestError("манифест: geo должен быть объектом {lat, lon}")
    try:
        return {"lat": float(value["lat"]), "lon": float(value["lon"])}
    except (TypeError, ValueError) as exc:
        raise DeviceManifestError("манифест: geo.lat/lon не числа") from exc


def parse_device_manifest(raw: Mapping[str, Any]) -> DeviceManifest:
    sha256 = str(raw.get("sha256") or "").lower()
    if len(sha256) != 64 or any(c not in "0123456789abcdef" for c in sha256):
        raise DeviceManifestError("манифест: sha256 должен быть 64 hex-символа")
    captured_raw = raw.get("captured_at_device")
    if not isinstance(captured_raw, str):
        raise DeviceManifestError("манифест без captured_at_device (ISO-8601)")
    try:
        captured_at = datetime.fromisoformat(captured_raw)
    except ValueError as exc:
        raise DeviceManifestError("манифест: captured_at_device не ISO-8601") from exc
    if captured_at.tzinfo is None:
        raise DeviceManifestError("манифест: captured_at_device без часового пояса")
    device_key_raw = raw.get("device_key_id")
    try:
        device_key_id = int(device_key_raw)  # type: ignore[arg-type]
    except (TypeError, ValueError) as exc:
        raise DeviceManifestError("манифест без device_key_id") from exc
    clock_sync = raw.get("clock_sync")
    clock_skew_ms: int | None = None
    if isinstance(clock_sync, Mapping) and clock_sync.get("skew_ms") is not None:
        try:
            clock_skew_ms = int(clock_sync["skew_ms"])
        except (TypeError, ValueError) as exc:
            raise DeviceManifestError("манифест: clock_sync.skew_ms не целое") from exc
    contract_id = _uuid(raw, "contract_id", required=True)
    assert contract_id is not None
    return DeviceManifest(
        sha256=sha256,
        captured_at_device=captured_at,
        contract_id=contract_id,
        device_key_id=device_key_id,
        milestone_id=_uuid(raw, "milestone_id", required=False),
        checklist_item_id=_uuid(raw, "checklist_item_id", required=False),
        assignment_id=_uuid(raw, "assignment_id", required=False),
        geo=_geo(raw),
        clock_skew_ms=clock_skew_ms,
    )


def verify_signature(
    *, public_key: bytes, algorithm: str, message: bytes, signature: bytes
) -> bool:
    """`True` — подпись верна. Неизвестный алгоритм, битый ключ, неверная
    подпись — `False` (вызывающая сторона различать причины не должна: ответ
    клиенту один — `device_manifest_invalid`)."""
    try:
        if algorithm == ALGORITHM_ED25519:
            Ed25519PublicKey.from_public_bytes(public_key).verify(signature, message)
            return True
        if algorithm == ALGORITHM_ECDSA_P256:
            loaded = serialization.load_der_public_key(public_key)
            if not isinstance(loaded, ec.EllipticCurvePublicKey):
                return False
            loaded.verify(signature, message, ec.ECDSA(hashes.SHA256()))
            return True
    except (InvalidSignature, ValueError, TypeError):
        return False
    return False
