"""Серверная половина DeviceKey-манифеста (ADR-053 п.2, ADR-136 п.6):
разбор/каноническая форма/подпись (чистые функции) + сервис за флагом
`EVIDENCE_DEVICE_MANIFEST_ENABLED`: ключ пользователя, подпись, хеш,
договор/этап, назначение на момент съёмки (фасад apps.authority), гео —
шифротекстом, `lateness` по окну 72 ч, `strong_protection`."""

from __future__ import annotations

import base64
import json
from datetime import timedelta

import pytest
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from django.test import override_settings
from django.utils import timezone

from apps.accounts.models import DeviceKey, UserDevice
from apps.authority import services as authority_services
from apps.authority.models import Representative
from apps.entities.models import BusinessEntity
from apps.evidence import manifest as manifest_module
from apps.evidence import services
from apps.evidence.api.serializers import EvidenceSerializer
from apps.evidence.models import Evidence
from apps.evidence.storage import FakeEvidenceObjectStore
from apps.milestones.tests._execution_helpers import make_signed_contract_with_leaf, make_user
from common import crypto
from services.evidence_ingest import pipeline

from ._fixtures import jpeg_without_exif

pytestmark = pytest.mark.django_db(databases=["default", "audit"])

# --- чистые функции -----------------------------------------------------------


def test_canonical_bytes_sorted_and_compact():
    a = manifest_module.canonical_manifest_bytes({"b": 1, "a": {"y": [1, 2], "x": "ж"}})
    b = manifest_module.canonical_manifest_bytes({"a": {"x": "ж", "y": [1, 2]}, "b": 1})
    assert a == b == b'{"a":{"x":"\\u0436","y":[1,2]},"b":1}'


def test_ed25519_roundtrip_and_tamper():
    private = Ed25519PrivateKey.generate()
    public = private.public_key().public_bytes(
        serialization.Encoding.Raw, serialization.PublicFormat.Raw
    )
    message = b"manifest"
    signature = private.sign(message)
    assert manifest_module.verify_signature(
        public_key=public, algorithm="ed25519", message=message, signature=signature
    )
    assert not manifest_module.verify_signature(
        public_key=public, algorithm="ed25519", message=b"manifest!", signature=signature
    )
    assert not manifest_module.verify_signature(
        public_key=public, algorithm="rsa", message=message, signature=signature
    )
    assert not manifest_module.verify_signature(
        public_key=b"garbage", algorithm="ed25519", message=message, signature=signature
    )


def test_ecdsa_p256_roundtrip():
    private = ec.generate_private_key(ec.SECP256R1())
    public = private.public_key().public_bytes(
        serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo
    )
    message = b"manifest"
    signature = private.sign(message, ec.ECDSA(hashes.SHA256()))
    assert manifest_module.verify_signature(
        public_key=public, algorithm="ecdsa_p256", message=message, signature=signature
    )
    assert not manifest_module.verify_signature(
        public_key=public, algorithm="ecdsa_p256", message=b"x", signature=signature
    )


@pytest.mark.parametrize(
    "broken",
    [
        {},
        {"sha256": "zz", "captured_at_device": "2026-08-26T10:00:00+00:00", "contract_id": "x"},
        {"sha256": "a" * 64, "captured_at_device": "2026-08-26T10:00:00", "contract_id": "x"},
        {"sha256": "a" * 64, "captured_at_device": "2026-08-26T10:00:00+00:00"},
        {
            "sha256": "a" * 64,
            "captured_at_device": "2026-08-26T10:00:00+00:00",
            "contract_id": "not-a-uuid",
            "device_key_id": 1,
        },
        {
            "sha256": "a" * 64,
            "captured_at_device": "2026-08-26T10:00:00+00:00",
            "contract_id": "0190f000-0000-7000-8000-000000000001",
            "device_key_id": 1,
            "geo": {"lat": 1},
        },
    ],
)
def test_parse_rejects_broken_manifests(broken):
    with pytest.raises(manifest_module.DeviceManifestError):
        manifest_module.parse_device_manifest(broken)


# --- сервис ---------------------------------------------------------------------


@pytest.fixture
def customer():
    return make_user("dm001")


@pytest.fixture
def contractor():
    return make_user("dm002")


@pytest.fixture
def signed(customer, contractor):
    return make_signed_contract_with_leaf(customer=customer, contractor=contractor)


@pytest.fixture
def store():
    return FakeEvidenceObjectStore()


@pytest.fixture
def device(contractor):
    private = Ed25519PrivateKey.generate()
    user_device = UserDevice.objects.create(user=contractor, platform="android")
    key = DeviceKey.objects.create(
        device=user_device,
        user=contractor,
        public_key=private.public_key().public_bytes(
            serialization.Encoding.Raw, serialization.PublicFormat.Raw
        ),
        algorithm="ed25519",
    )
    return private, key


def _manifest(content, contract, milestone, key, *, captured_delta=timedelta(hours=1), **extra):
    manifest = {
        "sha256": pipeline.compute_sha256(content),
        "captured_at_device": (timezone.now() - captured_delta).isoformat(),
        "contract_id": str(contract.id),
        "milestone_id": str(milestone.id),
        "checklist_item_id": None,
        "assignment_id": None,
        "device_key_id": key.pk,
        "geo": {"lat": 55.75, "lon": 37.62},
        "clock_sync": {"skew_ms": 120},
    }
    manifest.update(extra)
    return manifest


def _sign(private, manifest) -> bytes:
    return private.sign(manifest_module.canonical_manifest_bytes(manifest))


def _upload(contract, milestone, user, store, manifest, signature):
    return services.upload_evidence(
        contract,
        user=user,
        content=jpeg_without_exif(),
        file_name="photo.jpg",
        mime_type="image/jpeg",
        milestone_id=milestone.id,
        object_store=store,
        device_manifest=manifest,
        device_signature=signature,
    )


def test_manifest_rejected_while_flag_off(signed, contractor, store, device):
    contract, milestone = signed
    private, key = device
    manifest = _manifest(jpeg_without_exif(), contract, milestone, key)
    with pytest.raises(services.DeviceManifestDisabledError):
        _upload(contract, milestone, contractor, store, manifest, _sign(private, manifest))


@override_settings(EVIDENCE_DEVICE_MANIFEST_ENABLED=True)
def test_valid_manifest_gives_strong_protection(signed, contractor, store, device):
    contract, milestone = signed
    private, key = device
    manifest = _manifest(jpeg_without_exif(), contract, milestone, key)
    signature = _sign(private, manifest)

    evidence = _upload(contract, milestone, contractor, store, manifest, signature)

    assert evidence.device_key_id == key.pk
    assert bytes(evidence.device_signature) == signature
    assert evidence.captured_at_device is not None
    assert evidence.device_clock_skew_ms == 120
    assert evidence.lateness == Evidence.Lateness.ON_TIME
    assert evidence.metadata["manifest_sha256"] == manifest["sha256"]
    assert evidence.geo_encrypted is not None
    assert json.loads(
        crypto.decrypt_bytes_for_subject(bytes(evidence.geo_encrypted), evidence.geo_key_ref)
    ) == {
        "lat": 55.75,
        "lon": 37.62,
    }
    data = EvidenceSerializer(evidence).data
    assert data["strong_protection"] is True
    assert data["has_geo"] is True and "geo" not in data
    assert data["device_key_id"] == key.pk


@override_settings(EVIDENCE_DEVICE_MANIFEST_ENABLED=True)
def test_late_upload_is_marked_late_not_rejected(signed, contractor, store, device):
    contract, milestone = signed
    private, key = device
    manifest = _manifest(
        jpeg_without_exif(), contract, milestone, key, captured_delta=timedelta(days=5)
    )
    evidence = _upload(contract, milestone, contractor, store, manifest, _sign(private, manifest))
    assert evidence.lateness == Evidence.Lateness.LATE


@override_settings(EVIDENCE_DEVICE_MANIFEST_ENABLED=True)
def test_tampered_signature_is_rejected(signed, contractor, store, device):
    contract, milestone = signed
    private, key = device
    manifest = _manifest(jpeg_without_exif(), contract, milestone, key)
    signature = _sign(private, manifest)
    manifest["geo"] = {"lat": 0.0, "lon": 0.0}  # подписано другое
    with pytest.raises(services.DeviceManifestInvalidError):
        _upload(contract, milestone, contractor, store, manifest, signature)


@override_settings(EVIDENCE_DEVICE_MANIFEST_ENABLED=True)
def test_sha256_mismatch_is_rejected(signed, contractor, store, device):
    contract, milestone = signed
    private, key = device
    manifest = _manifest(b"other-bytes", contract, milestone, key)
    with pytest.raises(services.DeviceManifestInvalidError):
        _upload(contract, milestone, contractor, store, manifest, _sign(private, manifest))


@override_settings(EVIDENCE_DEVICE_MANIFEST_ENABLED=True)
def test_manifest_for_other_contract_is_rejected(signed, contractor, store, device):
    contract, milestone = signed
    private, key = device
    manifest = _manifest(
        jpeg_without_exif(),
        contract,
        milestone,
        key,
        contract_id="0190f000-0000-7000-8000-000000000001",
    )
    with pytest.raises(services.DeviceManifestInvalidError):
        _upload(contract, milestone, contractor, store, manifest, _sign(private, manifest))


@override_settings(EVIDENCE_DEVICE_MANIFEST_ENABLED=True)
def test_key_of_another_user_is_rejected(signed, customer, store, device):
    contract, milestone = signed
    private, key = device  # ключ исполнителя, загружает заказчик
    manifest = _manifest(jpeg_without_exif(), contract, milestone, key)
    with pytest.raises(services.DeviceManifestInvalidError):
        _upload(contract, milestone, customer, store, manifest, _sign(private, manifest))


@override_settings(EVIDENCE_DEVICE_MANIFEST_ENABLED=True)
def test_key_revoked_before_capture_is_rejected(signed, contractor, store, device):
    contract, milestone = signed
    private, key = device
    key.revoked_at = timezone.now() - timedelta(days=1)
    key.save(update_fields=["revoked_at"])
    manifest = _manifest(jpeg_without_exif(), contract, milestone, key)
    with pytest.raises(services.DeviceManifestInvalidError):
        _upload(contract, milestone, contractor, store, manifest, _sign(private, manifest))


@override_settings(EVIDENCE_DEVICE_MANIFEST_ENABLED=True)
def test_key_revoked_after_capture_is_still_valid(signed, contractor, store, device):
    """ADR-053/005: снимок полномочий — материал, снятый до отзыва, остаётся."""
    contract, milestone = signed
    private, key = device
    manifest = _manifest(
        jpeg_without_exif(), contract, milestone, key, captured_delta=timedelta(hours=2)
    )
    signature = _sign(private, manifest)
    key.revoked_at = timezone.now() - timedelta(hours=1)
    key.save(update_fields=["revoked_at"])
    evidence = _upload(contract, milestone, contractor, store, manifest, signature)
    assert evidence.device_key_id == key.pk


# --- назначение (ContractAssignment, фасад apps.authority) ------------------


@pytest.fixture
def representative(customer, contractor):
    entity = BusinessEntity.objects.create(
        country_of_registration="RU",
        local_form_code="ru_ooo",
        name="ООО Съёмка",
        created_by=customer,
    )
    return Representative.objects.create(
        user=contractor,
        business_entity=entity,
        role="member",
        permissions=[Representative.Permission.UPLOAD_EVIDENCE],
    )


@override_settings(EVIDENCE_DEVICE_MANIFEST_ENABLED=True)
def test_valid_assignment_is_recorded(signed, customer, contractor, store, device, representative):
    contract, milestone = signed
    private, key = device
    assignment = authority_services.assign_to_contract(
        representative,
        customer,
        contract_id=contract.id,
        valid_from=timezone.now() - timedelta(days=1),
    )
    manifest = _manifest(
        jpeg_without_exif(), contract, milestone, key, assignment_id=str(assignment.id)
    )
    evidence = _upload(contract, milestone, contractor, store, manifest, _sign(private, manifest))
    assert evidence.assignment_id == assignment.id


@override_settings(EVIDENCE_DEVICE_MANIFEST_ENABLED=True)
def test_assignment_revoked_before_capture_is_rejected(
    signed, customer, contractor, store, device, representative
):
    contract, milestone = signed
    private, key = device
    assignment = authority_services.assign_to_contract(
        representative,
        customer,
        contract_id=contract.id,
        valid_from=timezone.now() - timedelta(days=3),
    )
    authority_services.revoke_assignment(assignment)
    assignment.revoked_at = timezone.now() - timedelta(days=1)
    assignment.save(update_fields=["revoked_at"])
    manifest = _manifest(
        jpeg_without_exif(), contract, milestone, key, assignment_id=str(assignment.id)
    )
    with pytest.raises(services.AssignmentNotValidError):
        _upload(contract, milestone, contractor, store, manifest, _sign(private, manifest))


@override_settings(EVIDENCE_DEVICE_MANIFEST_ENABLED=True)
def test_assignment_revoked_after_capture_still_valid(
    signed, customer, contractor, store, device, representative
):
    contract, milestone = signed
    private, key = device
    assignment = authority_services.assign_to_contract(
        representative,
        customer,
        contract_id=contract.id,
        valid_from=timezone.now() - timedelta(days=3),
    )
    authority_services.revoke_assignment(assignment)  # отозвано СЕЙЧАС, снято час назад
    manifest = _manifest(
        jpeg_without_exif(), contract, milestone, key, assignment_id=str(assignment.id)
    )
    evidence = _upload(contract, milestone, contractor, store, manifest, _sign(private, manifest))
    assert evidence.assignment_id == assignment.id


@override_settings(EVIDENCE_DEVICE_MANIFEST_ENABLED=True)
def test_assignment_limited_to_other_milestone_is_rejected(
    signed, customer, contractor, store, device, representative
):
    contract, milestone = signed
    private, key = device
    assignment = authority_services.assign_to_contract(
        representative,
        customer,
        contract_id=contract.id,
        milestone_ids=["0190f000-0000-7000-8000-000000000002"],
        valid_from=timezone.now() - timedelta(days=1),
    )
    manifest = _manifest(
        jpeg_without_exif(), contract, milestone, key, assignment_id=str(assignment.id)
    )
    with pytest.raises(services.AssignmentNotValidError):
        _upload(contract, milestone, contractor, store, manifest, _sign(private, manifest))


@override_settings(EVIDENCE_DEVICE_MANIFEST_ENABLED=True)
def test_unknown_assignment_is_rejected(signed, contractor, store, device):
    contract, milestone = signed
    private, key = device
    manifest = _manifest(
        jpeg_without_exif(),
        contract,
        milestone,
        key,
        assignment_id="0190f000-0000-7000-8000-000000000003",
    )
    with pytest.raises(services.AssignmentNotValidError):
        _upload(contract, milestone, contractor, store, manifest, _sign(private, manifest))


def test_signature_base64_helper():
    assert base64.b64decode(base64.b64encode(b"sig")) == b"sig"
