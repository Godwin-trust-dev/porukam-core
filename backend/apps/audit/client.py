"""Фасад к Audit Vault (tech-spec.md §5.2.10: «apps.audit — клиент Audit
Vault»). Остальные apps.* обращаются к Vault ТОЛЬКО через этот модуль, не
импортируя services.audit_vault напрямую — apps.audit — единственная
разрешённая точка входа в периферийный сервис со своей БД (docs/adr/ADR-065-*.md).
"""

from __future__ import annotations

import uuid
from collections.abc import Callable
from datetime import datetime
from typing import Any

from services.audit_vault import api
from services.audit_vault import export as vault_export
from services.audit_vault.api import (
    ChainLink,
    ChainVerificationResult,
    CheckpointInfo,
    VaultReadPermissionError,
)
from services.audit_vault.models import AuditEntry

__all__ = [
    "AuditEntry",
    "ChainLink",
    "ChainVerificationResult",
    "CheckpointInfo",
    "VaultReadPermissionError",
    "append",
    "chain_links",
    "checkpoint_covering",
    "checkpoint_files",
    "checkpoint_openssl_commands",
    "checkpoint_record",
    "find_entry_seq",
    "read",
    "verify_chain",
]


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
    return api.append(
        actor=actor,
        actor_role=actor_role,
        action=action,
        target_type=target_type,
        target_id=target_id,
        payload=payload,
        at=at,
        source_event_id=source_event_id,
    )


def verify_chain(
    *, seq_from: int | None = None, seq_to: int | None = None
) -> ChainVerificationResult:
    return api.verify_chain(seq_from=seq_from, seq_to=seq_to)


def read(*, actor_role: str, **filters: Any) -> list[AuditEntry]:
    return api.read(actor_role=actor_role, **filters)


# --- ADR-139: цепочный путь для доказательного пакета сделки ----------------


def find_entry_seq(*, action: str, target_type: str, target_id: str) -> int | None:
    return api.find_entry_seq(action=action, target_type=target_type, target_id=target_id)


def checkpoint_covering(seq: int) -> CheckpointInfo | None:
    return api.checkpoint_covering(seq)


def chain_links(
    *, seq_from: int, seq_to: int, disclose: Callable[[AuditEntry], bool], max_links: int
) -> tuple[list[ChainLink], bool]:
    return api.chain_links(seq_from=seq_from, seq_to=seq_to, disclose=disclose, max_links=max_links)


def checkpoint_record(info: CheckpointInfo) -> dict[str, Any]:
    return vault_export.checkpoint_record(info)


def checkpoint_files(info: CheckpointInfo) -> list[tuple[str, bytes]]:
    return vault_export.checkpoint_files(info)


def checkpoint_openssl_commands(info: CheckpointInfo, *, directory: str) -> list[str]:
    return vault_export.openssl_commands(info, directory=directory)
