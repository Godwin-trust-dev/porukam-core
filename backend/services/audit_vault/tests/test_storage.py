"""S3CheckpointObjectStore под тремя режимами WORM (ADR-136) — фейковый
boto3-клиент, без MinIO/R2."""

from __future__ import annotations

from datetime import UTC, datetime
from unittest.mock import patch

from common import worm
from services.audit_vault.storage import S3CheckpointObjectStore


class FakeS3Client:
    def __init__(self) -> None:
        self.calls: list[dict[str, object]] = []

    def put_object(self, **kwargs: object) -> None:
        self.calls.append(kwargs)


def _put(mode: worm.WormMode) -> dict[str, object]:
    client = FakeS3Client()
    store = S3CheckpointObjectStore(bucket="vault", mode=mode)
    with patch.object(S3CheckpointObjectStore, "_client", return_value=client):
        store.put_worm(
            "checkpoints/000001-000002.json",
            b"{}",
            retain_until=datetime(2036, 1, 1, tzinfo=UTC),
        )
    (call,) = client.calls
    return call


def test_object_lock_mode_sends_compliance_retention():
    call = _put(worm.WormMode.OBJECT_LOCK)
    assert call["ObjectLockMode"] == "COMPLIANCE"
    assert call["ObjectLockRetainUntilDate"] == datetime(2036, 1, 1, tzinfo=UTC)
    assert call["Bucket"] == "vault"


def test_bucket_lock_mode_is_plain_put():
    call = _put(worm.WormMode.BUCKET_LOCK)
    assert "ObjectLockMode" not in call
    assert call["Key"] == "checkpoints/000001-000002.json"


def test_none_mode_is_plain_put():
    call = _put(worm.WormMode.NONE)
    assert "ObjectLockMode" not in call
