"""Хранилище checkpoint'ов Vault — WORM-объекты в S3-совместимом бакете
(MinIO в dev, Cloudflare R2 в проде; tech-spec.md §10.3). Протокол — по
образцу providers.py (apps.entities/apps.identity): ядро (tasks.py) не знает
про boto3/MinIO конкретно, только про CheckpointObjectStore. `boto3` —
опциональная runtime-зависимость этого модуля: импортируется лениво
(`common.object_store.build_s3_client`), чтобы модели/api/verify_chain не
требовали её наличия.

Режим неизменяемости — `common.worm` (ADR-136, `settings.WORM_MODE`):
`object_lock` — как было с ЭФ.3 (`ObjectLockMode=COMPLIANCE`, бакет создан
с локом); `bucket_lock` — Cloudflare R2, обычный put под правилом Bucket
Lock на префиксе `checkpoints/`; `none` — dev."""

from __future__ import annotations

from datetime import datetime
from typing import Any, Protocol

from django.conf import settings

from common import worm
from common.object_store import build_s3_client

CHECKPOINT_KEY_PREFIX = "checkpoints/"


class CheckpointObjectStore(Protocol):
    def put_worm(self, key: str, body: bytes, *, retain_until: datetime) -> None: ...


class S3CheckpointObjectStore:
    """MinIO/S3/R2 — режим неизменяемости из `settings.WORM_MODE`
    (`common.worm`). Для `object_lock` бакет должен быть создан С включённым
    Object Lock (`mc mb --with-lock`, dev-setup.md); для `bucket_lock` —
    правило на префиксе `checkpoints/` (прод-конфиг)."""

    def __init__(self, *, bucket: str | None = None, mode: worm.WormMode | None = None) -> None:
        self._bucket = bucket or settings.AUDIT_VAULT_BUCKET_NAME
        self._mode = mode if mode is not None else worm.resolve_worm_mode()

    def _client(self) -> Any:
        return build_s3_client()

    def put_worm(self, key: str, body: bytes, *, retain_until: datetime) -> None:
        worm.put_worm_object(
            self._client(),
            bucket=self._bucket,
            key=key,
            body=body,
            content_type="application/json",
            retain_until=retain_until,
            mode=self._mode,
        )


class FakeCheckpointObjectStore:
    """Детерминированный фейк для тестов — просто держит объекты в памяти,
    без реального WORM-поведения (проверять неизменяемость на фейке
    бессмысленно — это гарантия самого MinIO/S3/R2, не нашего кода)."""

    def __init__(self) -> None:
        self.objects: dict[str, bytes] = {}

    def put_worm(self, key: str, body: bytes, *, retain_until: datetime) -> None:
        self.objects[key] = body
