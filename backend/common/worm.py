"""Режим неизменяемости (WORM) объектных хранилищ — ОДИН модуль для
оригиналов доказательств (`apps.evidence.storage`) и чекпойнтов Audit
Vault (`services.audit_vault.storage`); docs/adr/ADR-136-evidence-etap6-
foundation.md.

Три режима, `settings.WORM_MODE` (env `WORM_MODE`):

- `object_lock` — S3 Object Lock per-object: `put_object(...,
  ObjectLockMode="COMPLIANCE", ObjectLockRetainUntilDate=...)`. Бакет
  ДОЛЖЕН быть создан с включённым Object Lock (`mc mb --with-lock` на
  MinIO; на существующем бакете включить нельзя). Так работал Audit Vault
  с ЭФ.3 (S3CheckpointObjectStore).
- `bucket_lock` — Cloudflare R2 (прод, решение владельца 26.08). R2 НЕ
  поддерживает Object Lock per-object (`ObjectLockMode` в put_object
  отвергается); неизменяемость там — **Bucket Lock**: правило хранения на
  бакет/префикс (N дней или бессрочно), включается в дашборде Cloudflare или
  через их API, работает и на существующем бакете; удалить/перезаписать
  объект под правилом нельзя. Код кладёт объект ОБЫЧНЫМ `put_object` и
  полагается на правило — поэтому при старте в лог уходит предупреждение,
  какие префиксы обязаны быть под правилом (`startup_notice`). Проверить
  правило из кода нельзя: у R2 нет S3-эндпоинта для чтения Bucket Lock, это
  инфраструктурный шаг владельца (прод-конфиг).
- `none` — dev/тесты: обычный бакет, никакой неизменяемости.

Модуль — чистые функции над «boto3-подобным» клиентом (утиная типизация:
достаточно `put_object(**kwargs)`), чтобы все три режима проверялись
фейковым клиентом без MinIO/R2."""

from __future__ import annotations

import logging
from datetime import datetime
from enum import StrEnum
from typing import Any, Protocol

from django.conf import settings

logger = logging.getLogger(__name__)


class WormMode(StrEnum):
    OBJECT_LOCK = "object_lock"
    BUCKET_LOCK = "bucket_lock"
    NONE = "none"


class UnknownWormModeError(ValueError):
    """`WORM_MODE` вне {object_lock, bucket_lock, none} — ошибка конфигурации
    окружения, не тихий фолбэк: неизменяемость доказательств не должна
    «выключаться» опечаткой в env."""


class S3PutClient(Protocol):
    def put_object(self, **kwargs: Any) -> Any: ...  # noqa: ANN401


def resolve_worm_mode(raw: str | None = None) -> WormMode:
    value = raw if raw is not None else getattr(settings, "WORM_MODE", WormMode.NONE.value)
    try:
        return WormMode(str(value))
    except ValueError as exc:
        raise UnknownWormModeError(
            f"WORM_MODE={value!r}: допустимы {', '.join(m.value for m in WormMode)}"
        ) from exc


def put_object_kwargs(mode: WormMode, *, retain_until: datetime | None) -> dict[str, Any]:
    """Дополнительные kwargs `put_object` для режима. `bucket_lock`/`none` —
    пусто (R2 отвергает ObjectLock*-параметры, обычный бакет их игнорирует —
    но полагаться на «игнорирует» нельзя, поэтому не шлём вовсе)."""
    if mode is WormMode.OBJECT_LOCK:
        if retain_until is None:
            raise ValueError("object_lock требует retain_until (ObjectLockRetainUntilDate)")
        return {"ObjectLockMode": "COMPLIANCE", "ObjectLockRetainUntilDate": retain_until}
    return {}


def put_worm_object(
    client: S3PutClient,
    *,
    bucket: str,
    key: str,
    body: bytes,
    content_type: str,
    retain_until: datetime | None,
    mode: WormMode,
) -> None:
    client.put_object(
        Bucket=bucket,
        Key=key,
        Body=body,
        ContentType=content_type,
        **put_object_kwargs(mode, retain_until=retain_until),
    )


def startup_notice(mode: WormMode, *, bucket: str, prefixes: tuple[str, ...]) -> str:
    """Текст предупреждения при старте процесса — что режим требует от
    инфраструктуры. Возвращает строку (а не логирует сам), чтобы тест
    проверял формулировку, а вызывающая сторона решала уровень лога."""
    if mode is WormMode.BUCKET_LOCK:
        return (
            f"WORM_MODE=bucket_lock: бакет {bucket!r} обязан иметь правило Bucket Lock "
            f"(Cloudflare R2 → бакет → Settings → Bucket lock) на префиксах "
            f"{', '.join(prefixes)} — из кода это не проверяется, см. прод-конфиг"
        )
    if mode is WormMode.OBJECT_LOCK:
        return (
            f"WORM_MODE=object_lock: бакет {bucket!r} должен быть создан с Object Lock "
            "(включить на существующем бакете нельзя)"
        )
    return f"WORM_MODE=none: бакет {bucket!r} без неизменяемости (только dev/тесты)"


def log_startup_notice(*, bucket: str, prefixes: tuple[str, ...]) -> None:
    mode = resolve_worm_mode()
    message = startup_notice(mode, bucket=bucket, prefixes=prefixes)
    if mode is WormMode.NONE:
        logger.info(message)
    else:
        logger.warning(message)
