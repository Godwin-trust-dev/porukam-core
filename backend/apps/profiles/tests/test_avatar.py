"""Фото профиля (ADR-103, docs/tasks/Задача_feat_profiles-avatar.md):
обработка изображения, сервисы, API, видимость deals_only, импорт из Google."""

from __future__ import annotations

import io
import re

import pytest
from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import override_settings
from django.utils import timezone
from PIL import Image
from rest_framework.test import APIClient

from apps.accounts import services as accounts_services
from apps.accounts.api.views import _sms_gateway
from apps.accounts.models import User
from apps.accounts.providers import FakeGoogleOAuthProvider
from apps.profiles import selectors, services
from apps.profiles.images import AVATAR_SIZES, InvalidAvatarImageError, process_avatar
from apps.profiles.models import Profile
from apps.profiles.storage import FakeAvatarObjectStore, build_avatar_store, reset_fake_store
from apps.profiles.subscriber import handle_event
from apps.reputation.models import DealFact
from common import relay
from common.models import OutboxEvent

pytestmark = pytest.mark.django_db(databases=["default", "audit"])


@pytest.fixture(autouse=True)
def _clean_store():
    reset_fake_store()
    yield
    reset_fake_store()


def _png(width: int = 400, height: int = 300, *, exif_orientation: int | None = None) -> bytes:
    image = Image.new("RGB", (width, height), (200, 30, 30))
    buffer = io.BytesIO()
    if exif_orientation is not None:
        exif = Image.Exif()
        exif[0x0112] = exif_orientation
        image.save(buffer, format="JPEG", exif=exif.tobytes())
    else:
        image.save(buffer, format="PNG")
    return buffer.getvalue()


def _code_for(phone: str) -> str:
    for sent_phone, message in reversed(_sms_gateway.sent):
        if sent_phone == phone:
            match = re.search(r"\d{6}", message)
            assert match
            return match.group()
    raise AssertionError(f"код для {phone} не отправлялся")


def _login(client: APIClient, phone: str) -> dict:
    resp = client.post("/v1/auth/otp/request", {"phone": phone}, format="json")
    assert resp.status_code == 200, resp.content
    resp = client.post(
        "/v1/auth/otp/verify", {"phone": phone, "code": _code_for(phone)}, format="json"
    )
    assert resp.status_code == 200, resp.content
    client.credentials(HTTP_AUTHORIZATION=f"Bearer {resp.data['access']}")
    relay.deliver_due_events()
    return resp.data


def _own_profile_id(client: APIClient) -> str:
    return client.post("/v1/profiles", {"kind": "person"}, format="json").data["id"]


def _upload(client: APIClient, profile_id: str, content: bytes, name: str = "a.png"):
    return client.post(
        f"/v1/profiles/{profile_id}/avatar",
        {"file": SimpleUploadedFile(name, content, content_type="image/png")},
        format="multipart",
    )


# --- images.process_avatar ---------------------------------------------------


def test_process_avatar_produces_square_webp_variants_without_exif():
    variants = process_avatar(_png(400, 300, exif_orientation=6))
    assert set(variants) == set(AVATAR_SIZES)
    for size, body in variants.items():
        image = Image.open(io.BytesIO(body))
        assert image.format == "WEBP"
        assert image.size == (size, size)
        assert not image.getexif()
    assert len(variants[256]) < 40_000  # «очень маленькая копия»


def test_process_avatar_rejects_non_image():
    with pytest.raises(InvalidAvatarImageError):
        process_avatar(b"definitely not an image")


@override_settings(PROFILE_AVATAR_MAX_SOURCE_PIXELS=10_000)
def test_process_avatar_rejects_too_many_pixels():
    with pytest.raises(InvalidAvatarImageError):
        process_avatar(_png(200, 200))


# --- services ---------------------------------------------------------------


@pytest.fixture
def user() -> User:
    return User.objects.create(trust_id="trust-avatar-1", phone="+79990940001")


@pytest.fixture
def profile(user: User) -> Profile:
    return services.create_person_profile(user, profile_public=True)


def test_set_avatar_replaces_and_deletes_old_objects(profile: Profile, user: User):
    store = FakeAvatarObjectStore()
    services.set_avatar(
        profile, user, content=_png(), source=Profile.AvatarSource.UPLOAD, store=store
    )
    first_key = profile.avatar_key
    assert first_key.startswith(f"avatars/{profile.id}/")
    assert set(store.objects) == {services.avatar_object_key(first_key, s) for s in AVATAR_SIZES}

    services.set_avatar(
        profile, user, content=_png(100, 100), source=Profile.AvatarSource.UPLOAD, store=store
    )
    assert profile.avatar_key != first_key
    assert set(store.objects) == {
        services.avatar_object_key(profile.avatar_key, s) for s in AVATAR_SIZES
    }
    assert profile.avatar_source == Profile.AvatarSource.UPLOAD
    assert profile.avatar_updated_at is not None


def test_remove_avatar_deletes_objects_and_is_idempotent(profile: Profile, user: User):
    store = FakeAvatarObjectStore()
    services.set_avatar(
        profile, user, content=_png(), source=Profile.AvatarSource.GOOGLE, store=store
    )
    services.remove_avatar(profile, user, store=store)
    assert profile.avatar_key == ""
    assert profile.avatar_source == Profile.AvatarSource.NONE
    assert store.objects == {}
    services.remove_avatar(profile, user, store=store)  # повтор — no-op


@override_settings(PROFILE_AVATAR_MAX_UPLOAD_BYTES=100)
def test_set_avatar_enforces_size_limit(profile: Profile, user: User):
    with pytest.raises(services.AvatarTooLargeError):
        services.set_avatar(profile, user, content=_png(), source=Profile.AvatarSource.UPLOAD)


def test_set_avatar_requires_edit_permission(profile: Profile):
    stranger = User.objects.create(trust_id="trust-avatar-stranger", phone="+79990940002")
    with pytest.raises(services.ProfilePermissionDeniedError):
        services.set_avatar(profile, stranger, content=_png(), source=Profile.AvatarSource.UPLOAD)


def test_import_external_avatar_only_when_empty(profile: Profile, user: User):
    store = FakeAvatarObjectStore()
    calls: list[str] = []

    def fetcher(url: str) -> bytes | None:
        calls.append(url)
        return _png()

    assert (
        services.import_external_avatar(
            profile, "https://lh3.example/photo", fetcher=fetcher, store=store
        )
        is True
    )
    assert profile.avatar_source == Profile.AvatarSource.GOOGLE
    # Повторный импорт (повторный логин) — загруженное не перетирается.
    assert (
        services.import_external_avatar(
            profile, "https://lh3.example/photo2", fetcher=fetcher, store=store
        )
        is False
    )
    assert calls == ["https://lh3.example/photo"]


def test_import_external_avatar_tolerates_bad_payload(profile: Profile):
    assert (
        services.import_external_avatar(profile, "https://x/y", fetcher=lambda _u: b"garbage")
        is False
    )
    assert services.import_external_avatar(profile, "https://x/y", fetcher=lambda _u: None) is False
    assert profile.avatar_key == ""


def test_fetch_https_image_refuses_plain_http():
    assert services.fetch_https_image("http://insecure.example/a.png") is None


# --- API ---------------------------------------------------------------------


def test_upload_and_get_avatar_public():
    owner = APIClient()
    _login(owner, "+79990940010")
    profile_id = _own_profile_id(owner)

    resp = _upload(owner, profile_id, _png())
    assert resp.status_code == 200, resp.content
    url = resp.data["avatar_url"]
    assert url.startswith(f"/v1/profiles/{profile_id}/avatar?size=256&v=")
    assert "&t=" not in url  # public — без подписи

    guest = APIClient()
    image = guest.get(url)
    assert image.status_code == 200
    assert image["Content-Type"] == "image/webp"
    assert Image.open(io.BytesIO(image.content)).size == (256, 256)
    small = guest.get(f"/v1/profiles/{profile_id}/avatar?size=64")
    assert Image.open(io.BytesIO(small.content)).size == (64, 64)

    # /users/me несёт avatar_url владельца
    me = owner.get("/v1/users/me")
    assert me.data["profiles"][0]["avatar_url"] == url


def test_get_avatar_404_when_missing():
    owner = APIClient()
    _login(owner, "+79990940011")
    profile_id = _own_profile_id(owner)
    assert APIClient().get(f"/v1/profiles/{profile_id}/avatar").status_code == 404
    detail = APIClient().get(f"/v1/profiles/{profile_id}")
    assert detail.data["avatar_url"] is None


def test_upload_rejects_non_image_and_too_large():
    owner = APIClient()
    _login(owner, "+79990940012")
    profile_id = _own_profile_id(owner)

    bad = _upload(owner, profile_id, b"not an image", name="a.txt")
    assert bad.status_code == 422, bad.content
    assert bad.data["code"] == "invalid_avatar_image"

    with override_settings(PROFILE_AVATAR_MAX_UPLOAD_BYTES=10):
        big = _upload(owner, profile_id, _png())
    assert big.status_code == 413, big.content
    assert big.data["code"] == "avatar_too_large"


def test_upload_forbidden_for_stranger_and_anonymous():
    owner = APIClient()
    _login(owner, "+79990940013")
    profile_id = _own_profile_id(owner)

    stranger = APIClient()
    _login(stranger, "+79990940014")
    assert _upload(stranger, profile_id, _png()).status_code == 403
    assert stranger.delete(f"/v1/profiles/{profile_id}/avatar").status_code == 403
    assert _upload(APIClient(), profile_id, _png()).status_code == 401


def test_delete_avatar_clears_url_and_objects():
    owner = APIClient()
    _login(owner, "+79990940015")
    profile_id = _own_profile_id(owner)
    url = _upload(owner, profile_id, _png()).data["avatar_url"]

    resp = owner.delete(f"/v1/profiles/{profile_id}/avatar")
    assert resp.status_code == 200, resp.content
    assert resp.data["avatar_url"] is None
    assert build_avatar_store().objects == {}  # type: ignore[attr-defined]  # fake в тестах
    assert APIClient().get(url).status_code == 404


def test_deals_only_avatar_visible_to_owner_counterparty_and_signed_link():
    owner = APIClient()
    _login(owner, "+79990940016")
    profile_id = _own_profile_id(owner)
    owner.patch(f"/v1/profiles/{profile_id}", {"avatar_visibility": "deals_only"}, format="json")
    upload = _upload(owner, profile_id, _png())
    assert upload.status_code == 200
    signed_url = upload.data["avatar_url"]
    assert "&t=" in signed_url

    # Гость: в карточке null, по прямому URL без подписи — 404.
    guest = APIClient()
    assert guest.get(f"/v1/profiles/{profile_id}").data["avatar_url"] is None
    assert guest.get(f"/v1/profiles/{profile_id}/avatar").status_code == 404
    # По подписанной ссылке — 200 (так её откроет <img> у контрагента).
    assert guest.get(signed_url).status_code == 200

    # Владелец по JWT без подписи — 200.
    assert owner.get(f"/v1/profiles/{profile_id}/avatar").status_code == 200

    # Посторонний залогиненный — null/404.
    other = APIClient()
    other_tokens = _login(other, "+79990940017")
    other_profile_id = _own_profile_id(other)
    other.credentials(
        HTTP_AUTHORIZATION=f"Bearer {other_tokens['access']}",
        HTTP_X_ACTING_PROFILE=other_profile_id,
    )
    assert other.get(f"/v1/profiles/{profile_id}").data["avatar_url"] is None
    assert other.get(f"/v1/profiles/{profile_id}/avatar").status_code == 404

    # Контрагент завершённой сделки — видит.
    DealFact.objects.create(
        contract_id="00000000-0000-0000-0000-0000000000a1",
        customer_profile_id=profile_id,
        contractor_profile_id=other_profile_id,
        is_completed=True,
        completed_at=timezone.now(),
    )
    card = other.get(f"/v1/profiles/{profile_id}")
    assert card.data["avatar_url"] is not None and "&t=" in card.data["avatar_url"]
    assert other.get(f"/v1/profiles/{profile_id}/avatar").status_code == 200
    rep = other.get(f"/v1/reputation/profiles/{profile_id}/card")
    assert rep.status_code == 200, rep.content
    assert rep.data["avatar_url"] is not None
    assert guest.get(f"/v1/reputation/profiles/{profile_id}/card").data["avatar_url"] is None


def test_signed_token_dies_with_avatar_replacement():
    owner = APIClient()
    _login(owner, "+79990940018")
    profile_id = _own_profile_id(owner)
    owner.patch(f"/v1/profiles/{profile_id}", {"avatar_visibility": "deals_only"}, format="json")
    old_url = _upload(owner, profile_id, _png()).data["avatar_url"]
    _upload(owner, profile_id, _png(50, 50))
    assert APIClient().get(old_url).status_code == 404


# --- Google: picture → стартовое фото ---------------------------------------


def test_fake_google_provider_parses_optional_picture():
    provider = FakeGoogleOAuthProvider()
    identity = provider.complete(
        code="sub-9|a@example.test|https://lh3.example/p.png", code_verifier="v"
    )
    assert identity.picture == "https://lh3.example/p.png"
    assert provider.complete(code="sub-9|a@example.test", code_verifier="v").picture is None


def test_google_registration_publishes_picture_only_once():
    provider = FakeGoogleOAuthProvider()
    _url, state = accounts_services.build_google_authorize_url(provider=provider)
    accounts_services.complete_google_login(
        code="sub-av-1|av1@example.test|https://lh3.example/p.png", state=state, provider=provider
    )
    first = OutboxEvent.objects.filter(topic="account.logged_in").latest("occurred_at")
    assert first.payload["avatar_source_url"] == "https://lh3.example/p.png"

    _url, state = accounts_services.build_google_authorize_url(provider=provider)
    accounts_services.complete_google_login(
        code="sub-av-1|av1@example.test|https://lh3.example/p2.png", state=state, provider=provider
    )
    second = OutboxEvent.objects.filter(topic="account.logged_in").latest("occurred_at")
    assert second.payload["created"] is False
    assert "avatar_source_url" not in second.payload


def test_subscriber_imports_google_picture_on_registration(
    user: User, monkeypatch, django_capture_on_commit_callbacks
):
    monkeypatch.setattr(services, "fetch_https_image", lambda _url: _png())
    event = OutboxEvent.objects.create(
        topic="account.logged_in",
        occurred_at=timezone.now(),
        actor={"user_id": str(user.id)},
        subject={"type": "user", "id": str(user.id)},
        payload={"created": True, "avatar_source_url": "https://lh3.example/p.png"},
    )
    # Задача ставится on_commit (профиль должен быть виден воркеру) и при
    # CELERY_TASK_ALWAYS_EAGER выполняется тут же.
    with django_capture_on_commit_callbacks(execute=True):
        handle_event(event)

    profile = Profile.objects.get(kind=Profile.Kind.PERSON, owner_user=user)
    assert profile.avatar_source == Profile.AvatarSource.GOOGLE
    assert profile.avatar_key
    assert selectors.avatar_url(profile, allowed=True) is not None


def test_subscriber_without_picture_leaves_profile_bare(user: User):
    event = OutboxEvent.objects.create(
        topic="account.logged_in",
        occurred_at=timezone.now(),
        actor={"user_id": str(user.id)},
        subject={"type": "user", "id": str(user.id)},
        payload={"created": True},
    )
    handle_event(event)
    profile = Profile.objects.get(kind=Profile.Kind.PERSON, owner_user=user)
    assert profile.avatar_key == ""
