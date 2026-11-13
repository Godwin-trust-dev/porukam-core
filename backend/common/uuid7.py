"""UUID v7 (RFC 9562): time-sortable PK для User (tech-spec.md §5.1 — "Т-решение":
time-sortable улучшает локальность индекса). Python 3.12 не имеет uuid.uuid7()
в stdlib (появится в 3.14) — реализуем сами по формату из RFC.
"""

from __future__ import annotations

import os
import time
import uuid


def uuid7() -> uuid.UUID:
    """48 бит unix-время в миллисекундах + 74 бита случайности, версия 7."""
    ms = time.time_ns() // 1_000_000
    value = bytearray(ms.to_bytes(6, "big") + os.urandom(10))
    value[6] = (value[6] & 0x0F) | 0x70  # версия 7
    value[8] = (value[8] & 0x3F) | 0x80  # вариант RFC 4122
    return uuid.UUID(bytes=bytes(value))
