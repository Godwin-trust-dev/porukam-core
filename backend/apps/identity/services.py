"""Use cases apps.identity (tech-spec.md §7.2, §7.4, §8.1; ADR-052, ADR-062).

apps.accounts.services.set_verified_identity() — ЕДИНСТВЕННЫЙ санкционированный
способ поднять User.verification_level/personal_tax_id_hash, вызывается
отсюда (не наоборот): apps.accounts ничего не знает о ЕСИА."""

from __future__ import annotations

import base64
import hashlib
import secrets

from django.core.cache import cache
from django.db import transaction
from django.utils import timezone

from apps.accounts import services as accounts_services
from apps.accounts.models import User
from common import outbox
from common.crypto import encrypt_for_subject

from .models import IdentityVerification
from .providers import IdentityVerificationProvider, InvalidVerificationCodeError

ESIA_STATE_TTL_SECONDS = 5 * 60


class EsiaStateInvalidError(ValueError):
    """state не найден, истёк или принадлежит другому пользователю — не
    повод раскрывать, какая из причин именно (CSRF-защита state-параметра)."""


class EsiaCodeInvalidError(ValueError):
    """Провайдер не распознал код авторизации."""


def _state_cache_key(state: str) -> str:
    return f"esia:state:{state}"


def _code_challenge(code_verifier: str) -> str:
    digest = hashlib.sha256(code_verifier.encode("utf-8")).digest()
    return base64.urlsafe_b64encode(digest).rstrip(b"=").decode("ascii")


def build_authorize_url(user: User, *, provider: IdentityVerificationProvider) -> tuple[str, str]:
    """GET /auth/esia/authorize-url. state и code_verifier (PKCE) хранятся
    только на сервере (Redis, TTL) и сверяются в complete_verification() —
    клиенту verifier не передаётся, только итоговый authorize_url и state."""
    state = secrets.token_urlsafe(24)
    code_verifier = secrets.token_urlsafe(32)
    cache.set(
        _state_cache_key(state),
        {"user_id": str(user.id), "code_verifier": code_verifier},
        timeout=ESIA_STATE_TTL_SECONDS,
    )
    url = provider.authorize_url(state=state, code_challenge=_code_challenge(code_verifier))
    return url, state


@transaction.atomic
def complete_verification(
    user: User, *, code: str, state: str, provider: IdentityVerificationProvider
) -> IdentityVerification:
    """POST /auth/esia/callback: поднимает verification_level до verified и
    пишет personal_tax_id_hash через apps.accounts.services.set_verified_identity
    (единственный санкционированный мутатор), сохраняет подтверждённые
    ФИО/атрибуты в IdentityVerification (envelope-шифрование ФИО)."""
    cached = cache.get(_state_cache_key(state))
    if cached is None or cached["user_id"] != str(user.id):
        raise EsiaStateInvalidError(
            f"state {state!r} не найден, истёк или принадлежит другому пользователю"
        )
    cache.delete(_state_cache_key(state))

    try:
        identity = provider.complete(code=code)
    except InvalidVerificationCodeError as exc:
        raise EsiaCodeInvalidError(str(exc)) from exc

    encrypted = encrypt_for_subject(identity.full_name, subject_type="user", subject_id=user.id)
    tax_id_hash = hashlib.sha256(identity.tax_id.encode("utf-8")).hexdigest()
    now = timezone.now()

    verification = IdentityVerification.objects.create(
        user=user,
        provider=provider.provider_code,
        level=IdentityVerification.Level.VERIFIED,
        verified_full_name_encrypted=encrypted.ciphertext,
        encryption_key_ref=encrypted.key_ref,
        verified_attributes=identity.attributes,
        verified_at=now,
        status=IdentityVerification.Status.SUCCEEDED,
    )

    accounts_services.set_verified_identity(user, tax_id_hash=tax_id_hash)

    outbox.publish(
        "identity.verified",
        subject={"type": "user", "id": str(user.id)},
        payload={"provider": provider.provider_code, "level": IdentityVerification.Level.VERIFIED},
        actor={"user_id": str(user.id)},
    )
    return verification
