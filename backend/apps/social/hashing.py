"""Хеширование номеров телефонной книги (152-ФЗ, docs/tasks/
etap-3-delta-adr059.md Р8): сырые номера на сервер не принимаются и не
хранятся — сверка идёт только по необратимым хешам.

Р1 (упрощение, задокументировано в docs/adr/): единая платформенная схема
хеширования — HMAC-SHA256 с секретным «перцем» из окружения
(settings.PHONEBOOK_HASH_PEPPER), которую обязаны использовать и клиент (при
хешировании телефонной книги), и сервер (пересчитывая хеш собственного
номера кандидата при сверке, apps.social.services.reconcile_phonebook).
`algorithm`/`salt_ref` в PhonebookHash сейчас — служебная версионная метка
схемы (проверяется на точное совпадение с ALGORITHM/SALT_REF), не выбор
клиента и не полноценный протокол приватного пересечения множеств (PSI) —
тот стал бы отдельной, более поздней задачей."""

from __future__ import annotations

import hashlib
import hmac
import re

from django.conf import settings

ALGORITHM = "hmac_sha256_v1"
SALT_REF = "platform-v1"

_HEX_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")


def phone_hash(phone: str) -> str:
    pepper = settings.PHONEBOOK_HASH_PEPPER.encode("utf-8")
    return hmac.new(pepper, phone.encode("utf-8"), hashlib.sha256).hexdigest()


def is_valid_hash_format(value: str) -> bool:
    """Грубый, но достаточный фильтр «это хеш, не сырой номер» (etap-3.md
    3.3: «сырые номера отклоняются валидацией» → 422): ожидаемая длина и
    алфавит hex-дайджеста SHA-256 — телефонный номер в любом формате этому
    не соответствует."""
    return bool(_HEX_SHA256_RE.fullmatch(value))
