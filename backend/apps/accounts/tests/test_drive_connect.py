"""Инкрементальная авторизация Google Drive (ADR-084, docs/tasks/
Задача_feat_evidence-drive.md §2.1-2.2) — ОТДЕЛЬНО от логина
(test_google_login.py не трогается). Уровень services.py — state+PKCE,
шифрование refresh-токена, рефреш access-токена — без HTTP (симметрично
test_google_login.py, `FakeGoogleDriveOAuthProvider`)."""

from __future__ import annotations

import pytest

from apps.accounts import services
from apps.accounts.models import GoogleDriveGrant, SocialLoginAccount, User
from apps.accounts.providers import FakeGoogleDriveOAuthProvider

pytestmark = pytest.mark.django_db

_PROVIDER = FakeGoogleDriveOAuthProvider()


def _make_user_with_google_login(sub: str = "sub-drive-1") -> User:
    user = User.objects.create(
        trust_id=f"trust-{sub}", verification_level=User.VerificationLevel.BASIC
    )
    SocialLoginAccount.objects.create(user=user, provider="google", sub=sub, email="a@x.com")
    return user


def test_build_drive_connect_authorize_url_ties_state_to_user():
    user = _make_user_with_google_login()
    url, state = services.build_drive_connect_authorize_url(user, provider=_PROVIDER)
    assert state
    assert "drive.file" in url or state in url


def test_complete_drive_connect_creates_grant_with_encrypted_refresh_token():
    user = _make_user_with_google_login("sub-drive-2")
    _url, state = services.build_drive_connect_authorize_url(user, provider=_PROVIDER)

    grant = services.complete_drive_connect(
        user=user, code="auth-code-1", state=state, provider=_PROVIDER
    )

    assert grant.status == GoogleDriveGrant.Status.ACTIVE
    assert grant.granted_scope == services.GOOGLE_DRIVE_GRANT_SCOPE
    # Токен в БД — НЕ plaintext (envelope-шифрование, ADR-059).
    assert b"fake-drive-refresh-auth-code-1" not in bytes(grant.refresh_token_encrypted)


def test_complete_drive_connect_is_idempotent_per_social_account():
    """Повторное подключение того же Google-аккаунта обновляет грант, не
    плодит вторую строку (OneToOneField)."""
    user = _make_user_with_google_login("sub-drive-3")
    _url, state1 = services.build_drive_connect_authorize_url(user, provider=_PROVIDER)
    grant1 = services.complete_drive_connect(
        user=user, code="code-a", state=state1, provider=_PROVIDER
    )

    _url, state2 = services.build_drive_connect_authorize_url(user, provider=_PROVIDER)
    grant2 = services.complete_drive_connect(
        user=user, code="code-b", state=state2, provider=_PROVIDER
    )

    assert grant1.id == grant2.id
    assert GoogleDriveGrant.objects.filter(social_account__user=user).count() == 1


def test_complete_drive_connect_without_google_login_raises():
    user = User.objects.create(
        trust_id="trust-no-google", verification_level=User.VerificationLevel.BASIC
    )
    _url, state = services.build_drive_connect_authorize_url(user, provider=_PROVIDER)

    with pytest.raises(services.DriveNoGoogleLoginError):
        services.complete_drive_connect(user=user, code="code", state=state, provider=_PROVIDER)


def test_complete_drive_connect_invalid_state_raises():
    user = _make_user_with_google_login("sub-drive-4")
    with pytest.raises(services.DriveConnectStateInvalidError):
        services.complete_drive_connect(
            user=user, code="code", state="not-a-real-state", provider=_PROVIDER
        )


def test_complete_drive_connect_state_issued_to_another_user_raises():
    user_a = _make_user_with_google_login("sub-drive-5a")
    user_b = _make_user_with_google_login("sub-drive-5b")
    _url, state = services.build_drive_connect_authorize_url(user_a, provider=_PROVIDER)

    with pytest.raises(services.DriveConnectStateInvalidError):
        services.complete_drive_connect(user=user_b, code="code", state=state, provider=_PROVIDER)


def test_has_drive_grant_false_before_connect_true_after():
    user = _make_user_with_google_login("sub-drive-6")
    assert services.has_drive_grant(user) is False

    _url, state = services.build_drive_connect_authorize_url(user, provider=_PROVIDER)
    services.complete_drive_connect(user=user, code="code", state=state, provider=_PROVIDER)
    assert services.has_drive_grant(user) is True


def test_get_drive_access_token_not_connected_raises():
    with pytest.raises(services.DriveNotConnectedError):
        services.get_drive_access_token("sub-never-connected", provider=_PROVIDER)


def test_get_drive_access_token_returns_fresh_access_token():
    user = _make_user_with_google_login("sub-drive-7")
    _url, state = services.build_drive_connect_authorize_url(user, provider=_PROVIDER)
    services.complete_drive_connect(user=user, code="code-7", state=state, provider=_PROVIDER)

    token = services.get_drive_access_token("sub-drive-7", provider=_PROVIDER)
    assert token.startswith("fake-drive-access-refreshed-")


def test_get_drive_access_token_invalid_grant_marks_revoked():
    """Google вернул invalid_grant (пользователь отозвал доступ в своих
    настройках) — грант переходит в revoked, дальнейшие вызовы падают
    DriveGrantRevokedError без повторного обращения к Google."""
    user = _make_user_with_google_login("sub-drive-8")
    _url, state = services.build_drive_connect_authorize_url(user, provider=_PROVIDER)
    services.complete_drive_connect(user=user, code="code-8", state=state, provider=_PROVIDER)

    failing_provider = FakeGoogleDriveOAuthProvider(fail_refresh=True)
    with pytest.raises(services.DriveGrantRevokedError):
        services.get_drive_access_token("sub-drive-8", provider=failing_provider)

    grant = GoogleDriveGrant.objects.get(social_account__user=user)
    assert grant.status == GoogleDriveGrant.Status.REVOKED
    assert grant.revoked_at is not None

    with pytest.raises(services.DriveGrantRevokedError):
        services.get_drive_access_token("sub-drive-8", provider=_PROVIDER)


def test_revoke_drive_grant_marks_revoked_and_has_grant_becomes_false():
    user = _make_user_with_google_login("sub-drive-9")
    _url, state = services.build_drive_connect_authorize_url(user, provider=_PROVIDER)
    services.complete_drive_connect(user=user, code="code-9", state=state, provider=_PROVIDER)
    assert services.has_drive_grant(user) is True

    services.revoke_drive_grant(user)

    assert services.has_drive_grant(user) is False
    with pytest.raises(services.DriveGrantRevokedError):
        services.get_drive_access_token("sub-drive-9", provider=_PROVIDER)
