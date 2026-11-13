"""Хранилище артефактов архива (`package.zip`/`files.zip`) — S3-совместимый
бакет (MinIO dev, Cloudflare R2 прод) либо фейк в памяти. Тот же приём, что
apps/evidence/storage.py: boto3 лениво (`common.object_store.build_s3_client`),
тумблер `settings.ARCHIVE_OBJECT_STORE=fake|s3` читается на каждый вызов.

НЕ WORM: `files.zip` обязан удаляться по сроку хранения (ADR-137 треб. 7 —
аудит фактического удаления), поэтому — обычный put/delete без
`common.worm`. Неизменяемость доказательства держит не бакет, а хеши:
`package_sha256`/`files_sha256` в `ArchiveExport` + событие `archive.ready`
в Audit Vault."""

from __future__ import annotations

from typing import Any, Protocol

from django.conf import settings

from common.object_store import build_s3_client

ARCHIVE_KEY_PREFIX = "archive/"


class ArchiveObjectStore(Protocol):
    def put(self, key: str, body: bytes, *, content_type: str) -> None: ...

    def get(self, key: str) -> bytes: ...

    def delete(self, key: str) -> None: ...


class S3ArchiveObjectStore:
    def __init__(self, *, bucket: str | None = None) -> None:
        self._bucket = bucket or settings.ARCHIVE_BUCKET_NAME

    def _client(self) -> Any:
        return build_s3_client()

    def put(self, key: str, body: bytes, *, content_type: str) -> None:
        self._client().put_object(Bucket=self._bucket, Key=key, Body=body, ContentType=content_type)

    def get(self, key: str) -> bytes:
        response = self._client().get_object(Bucket=self._bucket, Key=key)
        return response["Body"].read()  # type: ignore[no-any-return]

    def delete(self, key: str) -> None:
        self._client().delete_object(Bucket=self._bucket, Key=key)


class FakeArchiveObjectStore:
    def __init__(self) -> None:
        self.objects: dict[str, bytes] = {}

    def put(self, key: str, body: bytes, *, content_type: str) -> None:
        self.objects[key] = body

    def get(self, key: str) -> bytes:
        return self.objects[key]

    def delete(self, key: str) -> None:
        self.objects.pop(key, None)


_fake_store = FakeArchiveObjectStore()


def build_archive_object_store() -> ArchiveObjectStore:
    if settings.ARCHIVE_OBJECT_STORE == "s3":
        return S3ArchiveObjectStore()
    return _fake_store
