"""apps/evidence/storage.py (ADR-136): S3EvidenceObjectStore под тремя
режимами WORM на фейковом boto3-клиенте; тумблер EVIDENCE_OBJECT_STORE."""

from __future__ import annotations

from datetime import timedelta
from unittest.mock import patch

from django.test import override_settings
from django.utils import timezone

from apps.evidence import storage
from common import worm


class FakeS3Client:
    def __init__(self) -> None:
        self.calls: list[dict[str, object]] = []

    def put_object(self, **kwargs: object) -> None:
        self.calls.append(kwargs)

    def delete_object(self, **kwargs: object) -> None:
        self.calls.append({"delete": True, **kwargs})


def _put(mode: worm.WormMode) -> dict[str, object]:
    client = FakeS3Client()
    store = storage.S3EvidenceObjectStore(bucket="evidence", mode=mode)
    with patch.object(storage.S3EvidenceObjectStore, "_client", return_value=client):
        store.put("evidence/1/photo.jpg", b"cipher", content_type="application/octet-stream")
    (call,) = client.calls
    return call


@override_settings(EVIDENCE_WORM_RETENTION_DAYS=1200)
def test_object_lock_mode_locks_for_configured_days():
    before = timezone.now()
    call = _put(worm.WormMode.OBJECT_LOCK)
    assert call["ObjectLockMode"] == "COMPLIANCE"
    retain_until = call["ObjectLockRetainUntilDate"]
    assert retain_until >= before + timedelta(days=1200)  # type: ignore[operator]
    assert retain_until <= timezone.now() + timedelta(days=1200)  # type: ignore[operator]


def test_bucket_lock_mode_is_plain_put():
    call = _put(worm.WormMode.BUCKET_LOCK)
    assert "ObjectLockMode" not in call
    assert call["Bucket"] == "evidence"
    assert call["ContentType"] == "application/octet-stream"


def test_none_mode_is_plain_put():
    assert "ObjectLockMode" not in _put(worm.WormMode.NONE)


def test_delete_goes_to_delete_object():
    client = FakeS3Client()
    store = storage.S3EvidenceObjectStore(bucket="evidence", mode=worm.WormMode.NONE)
    with patch.object(storage.S3EvidenceObjectStore, "_client", return_value=client):
        store.delete("evidence/1/photo.jpg")
    assert client.calls == [{"delete": True, "Bucket": "evidence", "Key": "evidence/1/photo.jpg"}]


def test_build_store_toggle():
    with override_settings(EVIDENCE_OBJECT_STORE="fake"):
        assert isinstance(storage.build_evidence_object_store(), storage.FakeEvidenceObjectStore)
    with override_settings(EVIDENCE_OBJECT_STORE="s3", WORM_MODE="bucket_lock"):
        assert isinstance(storage.build_evidence_object_store(), storage.S3EvidenceObjectStore)
