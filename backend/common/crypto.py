"""Envelope-шифрование ПД (CLAUDE.md: "ПД — только crypto-shredding
(envelope encryption с первой миграции)"; решение историческое — ADR-035
внешнего журнала, локальная реализация — docs/adr/ADR-059-*.md).

Схема: мастер-ключ (KMS-заглушка — settings.ENVELOPE_MASTER_KEY) оборачивает
KEK субъекта (SubjectKey, common/models.py); KEK оборачивает одноразовый DEK
записи; DEK шифрует значение поля. AES-256-GCM везде. crypto-shredding —
destroy_subject_key(): необратимо уничтожает KEK, после чего расшифровка
любых полей субъекта невозможна (сами шифртексты не трогаем — soft-delete
юрзначимых сущностей запрещён, CLAUDE.md).
"""

from __future__ import annotations

import base64
import os
from dataclasses import dataclass

from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from django.conf import settings
from django.db import transaction
from django.utils import timezone

from .models import SubjectKey

_NONCE_LEN = 12
_KEY_LEN = 32


class SubjectKeyDestroyedError(ValueError):
    """Ключ субъекта уничтожен (crypto-shredding) или не существует —
    расшифровка невозможна в принципе, это не баг вызывающей стороны."""


def _master_key() -> bytes:
    key = base64.b64decode(settings.ENVELOPE_MASTER_KEY)
    if len(key) != _KEY_LEN:
        raise ValueError("ENVELOPE_MASTER_KEY должен декодироваться в 32 байта (base64)")
    return key


def _wrap(secret: bytes, key: bytes) -> bytes:
    nonce = os.urandom(_NONCE_LEN)
    return nonce + AESGCM(key).encrypt(nonce, secret, None)


def _unwrap(blob: bytes, key: bytes) -> bytes:
    nonce, ciphertext = blob[:_NONCE_LEN], blob[_NONCE_LEN:]
    return AESGCM(key).decrypt(nonce, ciphertext, None)


def _get_or_create_subject_key(subject_type: str, subject_id: str) -> SubjectKey:
    subject_key, _ = SubjectKey.objects.get_or_create(
        subject_type=subject_type,
        subject_id=subject_id,
        destroyed_at__isnull=True,
        defaults={"kek_wrapped": _wrap(os.urandom(_KEY_LEN), _master_key())},
    )
    return subject_key


@dataclass(frozen=True, slots=True)
class EncryptedField:
    ciphertext: bytes
    key_ref: str


def encrypt_bytes_for_subject(
    plaintext: bytes, *, subject_type: str, subject_id: object
) -> EncryptedField:
    """Байтовый вариант `encrypt_for_subject` (ADR-136: оригиналы
    доказательств шифруются ТЕМ ЖЕ конвертом — per-object DEK, KEK
    субъекта, мастер-ключ из env). Формат блоба: `len(wrapped_dek):2 ||
    wrapped_dek || nonce || ciphertext` — обёрнутый DEK лежит В БЛОБЕ
    (в S3-объекте), а не в отдельной колонке: без KEK субъекта (SubjectKey,
    БД) и мастер-ключа (env) он бесполезен, а crypto-shredding =
    `destroy_subject_key` делает нечитаемым сразу весь блоб, где бы тот ни
    лежал — в том числе в WORM-бакете, из которого объект удалить нельзя."""
    subject_key = _get_or_create_subject_key(subject_type, str(subject_id))
    kek = _unwrap(bytes(subject_key.kek_wrapped), _master_key())
    dek = os.urandom(_KEY_LEN)
    nonce = os.urandom(_NONCE_LEN)
    ciphertext = AESGCM(dek).encrypt(nonce, plaintext, None)
    wrapped_dek = _wrap(dek, kek)
    blob = len(wrapped_dek).to_bytes(2, "big") + wrapped_dek + nonce + ciphertext
    return EncryptedField(ciphertext=blob, key_ref=str(subject_key.id))


def encrypt_for_subject(plaintext: str, *, subject_type: str, subject_id: object) -> EncryptedField:
    """Шифрует значение поля для субъекта (subject_type/subject_id — напр.
    "user"/user.id). Создаёт SubjectKey субъекта, если его ещё нет."""
    return encrypt_bytes_for_subject(
        plaintext.encode("utf-8"), subject_type=subject_type, subject_id=subject_id
    )


def decrypt_bytes_for_subject(ciphertext: bytes, key_ref: str) -> bytes:
    try:
        subject_key = SubjectKey.objects.get(id=key_ref)
    except (SubjectKey.DoesNotExist, ValueError) as exc:
        raise SubjectKeyDestroyedError(f"ключ {key_ref!r} не найден") from exc
    if subject_key.destroyed_at is not None:
        raise SubjectKeyDestroyedError(f"ключ субъекта {key_ref!r} уничтожен (crypto-shredding)")
    kek = _unwrap(bytes(subject_key.kek_wrapped), _master_key())
    wrapped_len = int.from_bytes(ciphertext[:2], "big")
    offset = 2 + wrapped_len
    wrapped_dek, nonce, encrypted = (
        ciphertext[2:offset],
        ciphertext[offset : offset + _NONCE_LEN],
        ciphertext[offset + _NONCE_LEN :],
    )
    dek = _unwrap(wrapped_dek, kek)
    return AESGCM(dek).decrypt(nonce, encrypted, None)


def decrypt_for_subject(ciphertext: bytes, key_ref: str) -> str:
    return decrypt_bytes_for_subject(ciphertext, key_ref).decode("utf-8")


def is_subject_key_destroyed(key_ref: str) -> bool:
    """Ключ уничтожен (или не существует) — для read-моделей, которым нужно
    честно показать «оригинал нечитаем», не пытаясь расшифровать."""
    try:
        subject_key = SubjectKey.objects.get(id=key_ref)
    except (SubjectKey.DoesNotExist, ValueError):
        return True
    return subject_key.destroyed_at is not None


@transaction.atomic
def destroy_subject_key(subject_type: str, subject_id: object) -> None:
    """Crypto-shredding (domain-model.md §10.2): необратимо уничтожает KEK
    субъекта. Зашифрованные записи остаются (без soft-delete), но
    расшифровать их больше нельзя."""
    SubjectKey.objects.filter(
        subject_type=subject_type, subject_id=str(subject_id), destroyed_at__isnull=True
    ).update(destroyed_at=timezone.now(), kek_wrapped=b"")
