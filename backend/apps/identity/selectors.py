"""Read-слой apps.identity."""

from __future__ import annotations

from apps.accounts.models import User
from common.crypto import SubjectKeyDestroyedError, decrypt_for_subject

from .models import IdentityVerification


def get_latest_verification(user: User) -> IdentityVerification | None:
    return (
        IdentityVerification.objects.filter(user=user, status=IdentityVerification.Status.SUCCEEDED)
        .order_by("-verified_at")
        .first()
    )


def get_verified_full_name(verification: IdentityVerification) -> str | None:
    """Расшифровывает verified_full_name_encrypted. None, если поле пустое
    ЛИБО ключ субъекта уничтожен (crypto-shredding)."""
    if not verification.verified_full_name_encrypted or not verification.encryption_key_ref:
        return None
    try:
        return decrypt_for_subject(
            bytes(verification.verified_full_name_encrypted), verification.encryption_key_ref
        )
    except SubjectKeyDestroyedError:
        return None
