"""Хранилище ОРИГИНАЛОВ доказательств RU-режима (`storage_mode=ru`,
`JurisdictionConfig.evidence_server_storage_enabled=True`) — S3-совместимый
бакет (MinIO в dev, Cloudflare R2 в проде), тот же протокол-приём, что
`services/audit_vault/storage.py` (CheckpointObjectStore): ядро
(apps.evidence.services) не знает про boto3 конкретно, `boto3` — ленивый
рантайм-импорт (`common.object_store.build_s3_client`).

GLOBAL-режим этот модуль НЕ ИСПОЛЬЗУЕТ ВООБЩЕ — оригинал держится временно
в `Evidence.transit_payload` (БД, не S3) и удаляется после доставки
(`apps.evidence.services.download_original`).

ADR-136 (Э6): с этой ветки хранилище — WORM по `settings.WORM_MODE`
(`common.worm`: `object_lock` | `bucket_lock` (R2) | `none`), а тело объекта
— ШИФРОТЕКСТ (конвертное шифрование `common.crypto`, per-object DEK):
неизменяемость и crypto-shredding не конфликтуют, потому что удаление =
уничтожение ключа, а не объекта. `delete` в протоколе есть ТОЛЬКО для
management-команды `evidence_encrypt_backfill --delete-plaintext` в режиме
`none` (под правилом Bucket Lock / Object Lock удаление отвергнет само
хранилище — код на это и рассчитывает).

Тумблер `settings.EVIDENCE_OBJECT_STORE` (fake|s3) — как
`PROFILE_AVATAR_STORE`: до ADR-136 вызывающие стороны (api/views) вообще не
передавали store, и RU-загрузка в проде легла бы в фейк-память процесса."""

from __future__ import annotations

from datetime import timedelta
from typing import Any, Protocol

from django.conf import settings
from django.utils import timezone

from common import worm
from common.object_store import build_s3_client

EVIDENCE_KEY_PREFIX = "evidence/"


class EvidenceObjectStore(Protocol):
    def put(self, key: str, body: bytes, *, content_type: str) -> None: ...

    def get(self, key: str) -> bytes: ...

    def delete(self, key: str) -> None: ...


class S3EvidenceObjectStore:
    def __init__(self, *, bucket: str | None = None, mode: worm.WormMode | None = None) -> None:
        self._bucket = bucket or settings.EVIDENCE_BUCKET_NAME
        self._mode = mode if mode is not None else worm.resolve_worm_mode()

    def _client(self) -> Any:
        return build_s3_client()

    def put(self, key: str, body: bytes, *, content_type: str) -> None:
        # `retain_until` нужен только object_lock: срок лока объекта —
        # `EVIDENCE_WORM_RETENTION_DAYS` (настройка, не константа; по
        # умолчанию покрывает горячее + архивное хранение ADR-036 с запасом).
        # В момент загрузки дата окончания договора неизвестна, поэтому
        # срок — от загрузки; досрочное «удаление» всё равно идёт ключом.
        retain_until = timezone.now() + timedelta(days=settings.EVIDENCE_WORM_RETENTION_DAYS)
        worm.put_worm_object(
            self._client(),
            bucket=self._bucket,
            key=key,
            body=body,
            content_type=content_type,
            retain_until=retain_until,
            mode=self._mode,
        )

    def get(self, key: str) -> bytes:
        response = self._client().get_object(Bucket=self._bucket, Key=key)
        return response["Body"].read()  # type: ignore[no-any-return]

    def delete(self, key: str) -> None:
        self._client().delete_object(Bucket=self._bucket, Key=key)


class FakeEvidenceObjectStore:
    """Детерминированный фейк для тестов — просто держит объекты в памяти
    (тот же приём, что FakeCheckpointObjectStore)."""

    def __init__(self) -> None:
        self.objects: dict[str, bytes] = {}

    def put(self, key: str, body: bytes, *, content_type: str) -> None:
        self.objects[key] = body

    def get(self, key: str) -> bytes:
        return self.objects[key]

    def delete(self, key: str) -> None:
        self.objects.pop(key, None)


_fake_store = FakeEvidenceObjectStore()


def build_evidence_object_store() -> EvidenceObjectStore:
    """Тумблер `settings.EVIDENCE_OBJECT_STORE`: `s3` — бакет, иначе —
    фейк-синглтон процесса (тесты/локалка). Читается на каждый вызов, не на
    импорт — override_settings в тестах должен работать предсказуемо."""
    if settings.EVIDENCE_OBJECT_STORE == "s3":
        return S3EvidenceObjectStore()
    return _fake_store
