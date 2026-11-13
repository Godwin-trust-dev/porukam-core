"""common/worm.py (ADR-136): три режима неизменяемости на фейковом
boto3-подобном клиенте — object_lock шлёт ObjectLock*-параметры, bucket_lock
(R2) и none — нет; опечатка в WORM_MODE — ошибка, не тихий фолбэк."""

from __future__ import annotations

from datetime import UTC, datetime

import pytest
from django.test import override_settings

from common import worm


class FakeS3Client:
    def __init__(self) -> None:
        self.calls: list[dict[str, object]] = []

    def put_object(self, **kwargs: object) -> None:
        self.calls.append(kwargs)


_RETAIN = datetime(2030, 1, 1, tzinfo=UTC)


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("object_lock", worm.WormMode.OBJECT_LOCK),
        ("bucket_lock", worm.WormMode.BUCKET_LOCK),
        ("none", worm.WormMode.NONE),
    ],
)
def test_resolve_worm_mode_from_settings(raw, expected):
    with override_settings(WORM_MODE=raw):
        assert worm.resolve_worm_mode() is expected


def test_resolve_worm_mode_rejects_typo():
    with override_settings(WORM_MODE="objectlock"), pytest.raises(worm.UnknownWormModeError):
        worm.resolve_worm_mode()


def test_object_lock_puts_compliance_retention():
    client = FakeS3Client()
    worm.put_worm_object(
        client,
        bucket="b",
        key="evidence/x",
        body=b"1",
        content_type="application/octet-stream",
        retain_until=_RETAIN,
        mode=worm.WormMode.OBJECT_LOCK,
    )
    (call,) = client.calls
    assert call["ObjectLockMode"] == "COMPLIANCE"
    assert call["ObjectLockRetainUntilDate"] == _RETAIN
    assert call["Bucket"] == "b" and call["Key"] == "evidence/x" and call["Body"] == b"1"


def test_object_lock_requires_retain_until():
    with pytest.raises(ValueError):
        worm.put_object_kwargs(worm.WormMode.OBJECT_LOCK, retain_until=None)


@pytest.mark.parametrize("mode", [worm.WormMode.BUCKET_LOCK, worm.WormMode.NONE])
def test_bucket_lock_and_none_put_without_object_lock_params(mode):
    """R2 отвергает ObjectLock*-параметры — в bucket_lock их не должно быть
    вовсе, обычный put под правилом бакета; none — то же самое."""
    client = FakeS3Client()
    worm.put_worm_object(
        client,
        bucket="b",
        key="checkpoints/1",
        body=b"1",
        content_type="application/json",
        retain_until=_RETAIN,
        mode=mode,
    )
    (call,) = client.calls
    assert "ObjectLockMode" not in call
    assert "ObjectLockRetainUntilDate" not in call
    assert call["ContentType"] == "application/json"


def test_startup_notice_bucket_lock_names_prefixes():
    message = worm.startup_notice(
        worm.WormMode.BUCKET_LOCK, bucket="porukam", prefixes=("evidence/", "checkpoints/")
    )
    assert "Bucket Lock" in message
    assert "evidence/" in message and "checkpoints/" in message
    assert "прод-конфиг" in message


def test_startup_notice_object_lock_and_none():
    assert "Object Lock" in worm.startup_notice(
        worm.WormMode.OBJECT_LOCK, bucket="b", prefixes=("evidence/",)
    )
    assert "dev" in worm.startup_notice(worm.WormMode.NONE, bucket="b", prefixes=("evidence/",))
