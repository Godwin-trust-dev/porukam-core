"""Фото-обложка проекта портфолио (ADR-115): загрузка/просмотр/удаление.
Хранилище — FakeAvatarObjectStore (общее с аватарами), Pillow — реальный."""

from __future__ import annotations

import datetime as dt
import io

import pytest
from PIL import Image
from rest_framework.test import APIClient

from apps.accounts.models import User
from apps.profiles import services
from apps.profiles.models import Profile
from apps.profiles.storage import reset_fake_store

pytestmark = pytest.mark.django_db


def _png(width: int = 800, height: int = 600) -> bytes:
    buffer = io.BytesIO()
    Image.new("RGB", (width, height), (200, 120, 40)).save(buffer, format="PNG")
    return buffer.getvalue()


def _user(suffix: str) -> User:
    return User.objects.create(trust_id=f"trust-pf-{suffix}", phone=f"+7999095{suffix}")


@pytest.fixture(autouse=True)
def _fake_store(settings):
    settings.PROFILE_AVATAR_STORE = "fake"
    reset_fake_store()


@pytest.fixture
def owner():
    return _user("001")


@pytest.fixture
def profile(owner):
    return Profile.objects.create(
        kind=Profile.Kind.PERSON, owner_user=owner, profile_visibility="public"
    )


@pytest.fixture
def project(profile, owner):
    return services.create_portfolio_project(
        profile,
        owner,
        title="Кухня под ключ",
        sphere="renovation",
        completed_at=dt.date(2026, 5, 1),
    )


def test_upload_view_delete_flow(owner, profile, project):
    client = APIClient()
    client.force_authenticate(user=owner)
    upload = client.post(
        f"/v1/portfolio/projects/{project.id}/photo",
        {"file": io.BytesIO(_png())},
        format="multipart",
    )
    assert upload.status_code == 200, upload.content
    photo_url = upload.data["photo_url"]
    assert photo_url and photo_url.startswith(f"/v1/portfolio/projects/{project.id}/photo")

    guest = APIClient()
    shown = guest.get(f"/v1/portfolio/projects/{project.id}/photo", {"size": "320"})
    assert shown.status_code == 200
    assert shown["Content-Type"] == "image/webp"
    # Аспект сохранён (не квадрат): 800x600 → 320x240.
    thumb = Image.open(io.BytesIO(shown.content))
    assert thumb.size == (320, 240)

    removed = client.delete(f"/v1/portfolio/projects/{project.id}/photo")
    assert removed.status_code == 200
    assert removed.data["photo_url"] is None
    assert guest.get(f"/v1/portfolio/projects/{project.id}/photo").status_code == 404


def test_stranger_cannot_upload(profile, project):
    stranger = _user("002")
    client = APIClient()
    client.force_authenticate(user=stranger)
    resp = client.post(
        f"/v1/portfolio/projects/{project.id}/photo",
        {"file": io.BytesIO(_png())},
        format="multipart",
    )
    assert resp.status_code == 403


def test_not_an_image_rejected(owner, project):
    client = APIClient()
    client.force_authenticate(user=owner)
    resp = client.post(
        f"/v1/portfolio/projects/{project.id}/photo",
        {"file": io.BytesIO(b"definitely not a picture")},
        format="multipart",
    )
    assert resp.status_code == 422
    assert resp.data["code"] == "invalid_portfolio_image"


def test_replace_deletes_old_objects(owner, profile, project):
    services.set_project_photo(profile, owner, project, content=_png())
    first_key = project.photo_key
    services.set_project_photo(profile, owner, project, content=_png(640, 640))
    from apps.profiles.storage import build_avatar_store

    store = build_avatar_store()
    assert store.get(services.portfolio_object_key(first_key, 320)) is None
    assert store.get(services.portfolio_object_key(project.photo_key, 320)) is not None
