"""Audit Vault — единственная точка входа для остальной системы
(tech-spec.md §10.3: «односторонний API: append, verify_chain, read»).
Другие приложения (через apps.audit.client) НЕ трогают AuditEntry напрямую.

Все операции — на БД-алиасе "audit" (common.db_routers.AuditVaultRouter
маршрутизирует туда AuditEntry/AuditCheckpoint по app_label автоматически;
`.using("audit")` здесь — явная документация намерения, а не обязательное
условие для роутера).
"""

from __future__ import annotations

import uuid
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from django.conf import settings
from django.db import connections, transaction
from django.utils import timezone

from .canonical import GENESIS_HASH, canonical_bytes, compute_hash
from .models import AuditCheckpoint, AuditEntry

# Произвольная константа-ключ transaction-scoped advisory lock (снимается
# автоматически при COMMIT/ROLLBACK) — серилизует append() даже когда в
# таблице ещё нет строк (select_for_update на "последнюю строку" не спасает
# от гонки на пустой таблице, а advisory lock не зависит от наличия строк).
_CHAIN_LOCK_KEY = 782500171


class VaultReadPermissionError(PermissionError):
    """Роль без доступа к read() (tech-spec.md §10.3: только служебные роли)."""


@dataclass(frozen=True, slots=True)
class ChainVerificationResult:
    ok: bool
    entries_checked: int
    first_broken_seq: int | None


def _lock_chain_for_append() -> None:
    with connections["audit"].cursor() as cursor:
        cursor.execute("SELECT pg_advisory_xact_lock(%s)", [_CHAIN_LOCK_KEY])


@transaction.atomic(using="audit")
def append(
    *,
    actor: dict[str, Any],
    actor_role: str,
    action: str,
    target_type: str,
    target_id: str,
    payload: dict[str, Any],
    at: datetime | None = None,
    source_event_id: uuid.UUID | str | None = None,
) -> AuditEntry:
    """Добавляет запись в конец цепочки. Идемпотентна по `source_event_id`
    (ADR-064: подписчик обязан быть идемпотентен по event_id, т.к. реле
    может доставить событие повторно) — повторный вызов с тем же
    `source_event_id` возвращает уже существующую запись, не создавая
    дубль и не трогая цепочку."""
    if source_event_id is not None:
        existing = AuditEntry.objects.filter(source_event_id=source_event_id).first()
        if existing is not None:
            return existing

    _lock_chain_for_append()

    at = at or timezone.now()
    last = AuditEntry.objects.order_by("-seq").first()
    prev_hash = last.this_hash if last is not None else GENESIS_HASH
    next_seq = (last.seq if last is not None else 0) + 1

    canonical = canonical_bytes(
        seq=next_seq,
        actor=actor,
        actor_role=actor_role,
        action=action,
        target_type=target_type,
        target_id=target_id,
        payload=payload,
        at=at,
        prev_hash=prev_hash,
    )
    this_hash = compute_hash(prev_hash=prev_hash, canonical=canonical)

    return AuditEntry.objects.create(
        seq=next_seq,
        actor=actor,
        actor_role=actor_role,
        action=action,
        target_type=target_type,
        target_id=target_id,
        payload=payload,
        at=at,
        prev_hash=prev_hash,
        this_hash=this_hash,
        source_event_id=source_event_id,
    )


def verify_chain(
    *, seq_from: int | None = None, seq_to: int | None = None
) -> ChainVerificationResult:
    """Пересчитывает цепочку заново из `canonical(entry)` каждой строки —
    не доверяет хранимому `prev_hash`, только пересчитанному ожидаемому
    значению. Разрыв в любой точке (искажённое поле, подменённый
    `this_hash`, вырезанная строка) даёт `ok=False` с номером первой
    несошедшейся записи."""
    qs = AuditEntry.objects.order_by("seq")
    if seq_from is not None:
        qs = qs.filter(seq__gte=seq_from)
    if seq_to is not None:
        qs = qs.filter(seq__lte=seq_to)

    if seq_from is not None and seq_from > 1:
        anchor = AuditEntry.objects.filter(seq=seq_from - 1).first()
        expected_prev = anchor.this_hash if anchor is not None else GENESIS_HASH
    else:
        expected_prev = GENESIS_HASH

    checked = 0
    for entry in qs.iterator():
        canonical = canonical_bytes(
            seq=entry.seq,
            actor=entry.actor,
            actor_role=entry.actor_role,
            action=entry.action,
            target_type=entry.target_type,
            target_id=entry.target_id,
            payload=entry.payload,
            at=entry.at,
            prev_hash=expected_prev,
        )
        expected_hash = compute_hash(prev_hash=expected_prev, canonical=canonical)
        checked += 1
        if entry.prev_hash != expected_prev or entry.this_hash != expected_hash:
            return ChainVerificationResult(
                ok=False, entries_checked=checked, first_broken_seq=entry.seq
            )
        expected_prev = entry.this_hash

    return ChainVerificationResult(ok=True, entries_checked=checked, first_broken_seq=None)


def read(
    *,
    actor_role: str,
    target_type: str | None = None,
    target_id: str | None = None,
    action: str | None = None,
    seq_from: int | None = None,
    seq_to: int | None = None,
) -> list[AuditEntry]:
    """tech-spec.md §10.3: read() — только роли операторов платформы (backoffice).
    Заглушка авторизации (полноценный apps.backoffice/RBAC — не в рамках ЭФ.3): проверка по
    settings.AUDIT_VAULT_READ_ROLES, без учёта конкретного оператора."""
    allowed_roles: list[str] = getattr(settings, "AUDIT_VAULT_READ_ROLES", [])
    if actor_role not in allowed_roles:
        raise VaultReadPermissionError(f"роль {actor_role!r} не имеет доступа к read() Vault")

    qs = AuditEntry.objects.order_by("seq")
    if target_type is not None:
        qs = qs.filter(target_type=target_type)
    if target_id is not None:
        qs = qs.filter(target_id=target_id)
    if action is not None:
        qs = qs.filter(action=action)
    if seq_from is not None:
        qs = qs.filter(seq__gte=seq_from)
    if seq_to is not None:
        qs = qs.filter(seq__lte=seq_to)
    return list(qs)


# ---------------------------------------------------------------------------
# ADR-139: цепочный путь «запись -> корень чекпойнта» для доказательного
# пакета сделки. Это НЕ `read()` (только служебные роли, ADR-038): наружу уходит только
# то, что и так принадлежит стороне сделки — её собственные записи целиком
# (canonical), чужие звенья — ТОЛЬКО хешем (`this_hash`), без содержимого.
# ---------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class ChainLink:
    """Одно звено линейной цепочки (`this_hash = sha256(prev_hash ||
    canonical)`). `canonical` — только у раскрытых звеньев (записи этой
    сделки); у чужих — None: их содержимое сторонам не принадлежит."""

    seq: int
    prev_hash: str
    this_hash: str
    action: str
    at: str
    canonical: str | None


@dataclass(frozen=True, slots=True)
class CheckpointInfo:
    """Заверенный якорь диапазона (услуга TSA — ADR-135; на ветке без TSA
    `timestamps` пуст, `tsa_status` = fake)."""

    id: int
    seq_from: int
    seq_to: int
    root: str
    alg: str
    tsa_status: str
    host_id: str
    created_at: str
    object_key: str
    timestamps: list[dict[str, Any]]


def _entry_canonical(entry: AuditEntry) -> bytes:
    return canonical_bytes(
        seq=entry.seq,
        actor=entry.actor,
        actor_role=entry.actor_role,
        action=entry.action,
        target_type=entry.target_type,
        target_id=entry.target_id,
        payload=entry.payload,
        at=entry.at,
        prev_hash=entry.prev_hash,
    )


def find_entry_seq(*, action: str, target_type: str, target_id: str) -> int | None:
    """Первая (самая ранняя) запись цепочки по действию и цели — например
    `evidence.received` для конкретного доказательства."""
    return (
        AuditEntry.objects.filter(action=action, target_type=target_type, target_id=target_id)
        .order_by("seq")
        .values_list("seq", flat=True)
        .first()
    )


def checkpoint_info(checkpoint: AuditCheckpoint) -> CheckpointInfo:
    """Снимок чекпойнта для читателей вне Vault (apps.audit.client, экспорт
    файлов метки — `export.py`, management-команда). Поля ADR-135 (`alg`,
    `host_id`, `tsa_status`, `timestamps`) — из модели напрямую."""
    timestamps = checkpoint.timestamps
    return CheckpointInfo(
        id=checkpoint.pk,
        seq_from=checkpoint.seq_from,
        seq_to=checkpoint.seq_to,
        root=checkpoint.digest,
        alg=str(checkpoint.alg),
        tsa_status=str(checkpoint.tsa_status),
        host_id=str(checkpoint.host_id or ""),
        created_at=checkpoint.created_at.isoformat(),
        object_key=checkpoint.object_key,
        timestamps=list(timestamps) if isinstance(timestamps, list) else [],
    )


def checkpoint_covering(seq: int) -> CheckpointInfo | None:
    """Чекпойнт, диапазон которого включает `seq` (None — запись ещё не
    зачекпойнчена: суточный якорь ещё не ставился)."""
    checkpoint = AuditCheckpoint.objects.filter(seq_from__lte=seq, seq_to__gte=seq).first()
    if checkpoint is None:
        return None
    return checkpoint_info(checkpoint)


def chain_links(
    *, seq_from: int, seq_to: int, disclose: Callable[[AuditEntry], bool], max_links: int
) -> tuple[list[ChainLink], bool]:
    """Звенья [seq_from, seq_to] по порядку. `disclose(entry)` решает, отдавать
    ли canonical (записи этой сделки) или только хеш (чужие). Возвращает
    (звенья, truncated): при превышении `max_links` путь обрезается — флаг
    честно уходит в манифест."""
    links: list[ChainLink] = []
    truncated = False
    queryset = AuditEntry.objects.filter(seq__gte=seq_from, seq__lte=seq_to).order_by("seq")
    for entry in queryset.iterator(chunk_size=500):
        if len(links) >= max_links:
            truncated = True
            break
        links.append(
            ChainLink(
                seq=entry.seq,
                prev_hash=entry.prev_hash,
                this_hash=entry.this_hash,
                action=entry.action,
                at=entry.at.isoformat(),
                canonical=_entry_canonical(entry).decode("ascii") if disclose(entry) else None,
            )
        )
    return links, truncated
