"""Каноническая JSON-сериализация + sha256 — общий рецепт (house style),
уже применяемый в services/audit_vault/canonical.py для хеш-цепочки Vault.
Здесь — тот же рецепт БЕЗ цепочки (`prev_hash`), вынесенный в common/, чтобы
apps.contracts (ContractVersion.integrity_hash, etap-4.md Э4.4) мог его
переиспользовать: services.audit_vault — периферийный сервис со своей БД,
кросс-импорт из apps.* запрещён (CLAUDE.md).

Каноническая форма — JSON с сортированными ключами, без пробелов, ASCII
(`ensure_ascii=True`) — детерминированная сериализация одного и того же
логического содержания, независимая от порядка ключей во входном dict
(тест «одинаковый договор → одинаковый hash», etap-4.md Э4.4).
"""

from __future__ import annotations

import hashlib
import json
from typing import Any


def canonical_json_bytes(document: dict[str, Any]) -> bytes:
    return json.dumps(document, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode(
        "ascii"
    )


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()
