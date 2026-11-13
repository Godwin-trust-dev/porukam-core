"""apps.evidence.api — Э6 (ADR-136/137): публичная политика хранения,
новые поля сериализатора у веб-загрузки (пометка «без усиленной
доказательной защиты»), манифест DeviceKey через тот же upload."""

from __future__ import annotations

import base64
import json

import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import override_settings
from django.utils import timezone
from rest_framework.test import APIClient

from apps.accounts.models import DeviceKey, UserDevice
from apps.evidence import manifest as manifest_module
from services.evidence_ingest import pipeline

from ._fixtures import jpeg_without_exif
from .test_api import _signed_contract_with_started_leaf

pytestmark = pytest.mark.django_db(databases=["default", "audit"])


def test_retention_policy_is_public_and_cacheable():
    resp = APIClient().get("/v1/evidence/retention-policy")
    assert resp.status_code == 200, resp.content
    assert resp.data == {
        "hot_days": 90,
        "archive_days": 365,
        "notice_days": 10,
        "dispute_pause_cap_days": 180,
        "hashes_forever": True,
    }
    assert "public" in resp["Cache-Control"]


def test_web_upload_is_marked_without_strong_protection():
    _customer_client, contractor_client, _contract_id, milestone_id, *_ = (
        _signed_contract_with_started_leaf("+79990990201", "+79990990202", "61")
    )
    upload = SimpleUploadedFile("photo.jpg", jpeg_without_exif(), content_type="image/jpeg")
    resp = contractor_client.post(
        f"/v1/milestones/{milestone_id}/evidence", {"file": upload}, format="multipart"
    )
    assert resp.status_code == 201, resp.content
    assert resp.data["strong_protection"] is False
    assert resp.data["lateness"] == "unknown"
    assert resp.data["retention_state"] == "hot"
    assert resp.data["has_geo"] is False
    assert resp.data["device_key_id"] is None
    assert resp.data["original_available"] is True


def _manifest_upload(contractor_client, contractor, contract_id, milestone_id):
    private = Ed25519PrivateKey.generate()
    key = DeviceKey.objects.create(
        device=UserDevice.objects.create(user=contractor, platform="ios"),
        user=contractor,
        public_key=private.public_key().public_bytes(
            serialization.Encoding.Raw, serialization.PublicFormat.Raw
        ),
        algorithm="ed25519",
    )
    content = jpeg_without_exif()
    manifest = {
        "sha256": pipeline.compute_sha256(content),
        "captured_at_device": timezone.now().isoformat(),
        "contract_id": str(contract_id),
        "milestone_id": str(milestone_id),
        "device_key_id": key.pk,
    }
    signature = private.sign(manifest_module.canonical_manifest_bytes(manifest))
    upload = SimpleUploadedFile("photo.jpg", content, content_type="image/jpeg")
    return contractor_client.post(
        f"/v1/milestones/{milestone_id}/evidence",
        {
            "file": upload,
            "manifest": json.dumps(manifest),
            "signature": base64.b64encode(signature).decode("ascii"),
        },
        format="multipart",
    )


@override_settings(EVIDENCE_DEVICE_MANIFEST_ENABLED=True)
def test_manifest_via_upload_endpoint():
    _customer_client, contractor_client, contract_id, milestone_id, _customer, contractor, _ = (
        _signed_contract_with_started_leaf("+79990990203", "+79990990204", "62")
    )
    resp = _manifest_upload(contractor_client, contractor, contract_id, milestone_id)
    assert resp.status_code == 201, resp.content
    assert resp.data["strong_protection"] is True
    assert resp.data["lateness"] == "on_time"
    assert resp.data["captured_at_device"]


def test_manifest_rejected_with_409_while_disabled():
    _customer_client, contractor_client, contract_id, milestone_id, _customer, contractor, _ = (
        _signed_contract_with_started_leaf("+79990990205", "+79990990206", "63")
    )
    resp = _manifest_upload(contractor_client, contractor, contract_id, milestone_id)
    assert resp.status_code == 409, resp.content
    assert resp.data["code"] == "device_manifest_disabled"


def test_manifest_without_signature_is_400():
    _customer_client, contractor_client, _contract_id, milestone_id, *_ = (
        _signed_contract_with_started_leaf("+79990990207", "+79990990208", "64")
    )
    upload = SimpleUploadedFile("photo.jpg", jpeg_without_exif(), content_type="image/jpeg")
    resp = contractor_client.post(
        f"/v1/milestones/{milestone_id}/evidence",
        {"file": upload, "manifest": json.dumps({"sha256": "a" * 64})},
        format="multipart",
    )
    assert resp.status_code == 400, resp.content
