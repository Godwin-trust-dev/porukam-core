"""Каноническое сериализованное представление записи Vault для хеш-цепочки
(tech-spec.md §10.3: `this_hash = sha256(prev_hash || canonical(entry))`).

Каноническая форма — JSON с сортированными ключами, без пробелов, ASCII
(`ensure_ascii=True`) и `at` в ISO-8601 — детерминированная сериализация
одного и того же логического содержания, независимая от порядка передачи
kwargs в Python. `seq` и `prev_hash` входят в канон явно: перестановка
записей или подмена звена цепочки меняет хеш. `source_event_id` (служебное
поле дедупликации реле, ADR-064/065) НЕ входит — это не часть юридически
значимого содержания записи.
"""

from __future__ import annotations

import hashlib
import json
from datetime import datetime
from typing import Any

GENESIS_HASH = "0" * 64


def canonical_bytes(
    *,
    seq: int,
    actor: dict[str, Any],
    actor_role: str,
    action: str,
    target_type: str,
    target_id: str,
    payload: dict[str, Any],
    at: datetime,
    prev_hash: str,
) -> bytes:
    document = {
        "seq": seq,
        "actor": actor,
        "actor_role": actor_role,
        "action": action,
        "target_type": target_type,
        "target_id": target_id,
        "payload": payload,
        "at": at.isoformat(),
        "prev_hash": prev_hash,
    }
    return json.dumps(document, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode(
        "ascii"
    )


def compute_hash(*, prev_hash: str, canonical: bytes) -> str:
    return hashlib.sha256(prev_hash.encode("ascii") + canonical).hexdigest()
