"""Логотип объединения (ADR-117 §8): загрузка/замена/удаление лидером,
публичная отдача WebP, запреты. Пайплайн — common/images + common/object_store
(вынесены из apps/profiles этим же PR, поведение аватара не менялось)."""

from __future__ import annotations

import io

import pytest
from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import override_settings
from PIL import Image
from rest_framework.test import APIClient

from apps.accounts.models import User
from apps.social import services
from apps.social.models import AddressableGroup
from apps.social.storage import build_logo_store, reset_fake_store

pytestmark = pytest.mark.django_db


@pytest.fixture(autouse=True)
def _clean_store():
    reset_fake_store()
    yield
    reset_fake_store()


def _png(width: int = 400, height: int = 300) -> bytes:
    image = Image.new("RGB", (width, height), (30, 30, 200))
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return buffer.getvalue()


def _user(suffix: str) -> User:
    return User.objects.create(trust_id=f"trust-logo-{suffix}", phone=f"+7999095{suffix}")


@pytest.fixture
def leader() -> User:
    return _user("001")


def _group(leader: User, *, handle: str = "logo_guild", **kwargs) -> AddressableGroup:
    defaults: dict = {
        "kind": AddressableGroup.Kind.GUILD,
        "name": "Гильдия с логотипом",
        "sphere_code": "it",
    }
    defaults.update(kwargs)
    return services.create_group(leader, handle=handle, **defaults)


def _client(user: User) -> APIClient:
    client = APIClient()
    client.force_authenticate(user)
    return client


def _upload(client: APIClient, group_id, content: bytes, name: str = "logo.png"):
    return client.post(
        f"/v1/groups/{group_id}/logo",
        {"file": SimpleUploadedFile(name, content, content_type="image/png")},
        format="multipart",
    )


def test_leader_uploads_logo_and_anyone_gets_webp(leader):
    group = _group(leader)
    resp = _upload(_client(leader), group.id, _png())
    assert resp.status_code == 200, resp.content
    assert resp.data["logo_url"] is not None and "v=" in resp.data["logo_url"]

    got = APIClient().get(f"/v1/groups/{group.id}/logo")
    assert got.status_code == 200
    assert got["Content-Type"] == "image/webp"
    # Квадратный кроп: 256×256 из 400×300.
    image = Image.open(io.BytesIO(got.content))
    assert image.size == (256, 256)


def test_replace_deletes_old_objects(leader):
    group = _group(leader)
    _upload(_client(leader), group.id, _png())
    group.refresh_from_db()
    first_key = group.logo_key

    _upload(_client(leader), group.id, _png(500, 500))
    group.refresh_from_db()
    assert group.logo_key != first_key
    store = build_logo_store()
    assert store.get(services.logo_object_key(first_key, 256)) is None
    assert store.get(services.logo_object_key(group.logo_key, 256)) is not None


def test_delete_logo_is_idempotent_and_removes_objects(leader):
    group = _group(leader)
    _upload(_client(leader), group.id, _png())
    group.refresh_from_db()
    old_key = group.logo_key

    resp = _client(leader).delete(f"/v1/groups/{group.id}/logo")
    assert resp.status_code == 200, resp.content
    assert resp.data["logo_url"] is None
    assert build_logo_store().get(services.logo_object_key(old_key, 256)) is None
    # Повторное удаление — no-op.
    assert _client(leader).delete(f"/v1/groups/{group.id}/logo").status_code == 200


def test_member_cannot_upload_logo(leader):
    group = _group(leader)
    member = _user("002")
    services.join_group(group, member)
    resp = _upload(_client(member), group.id, _png())
    assert resp.status_code == 403, resp.content


def test_anonymous_cannot_upload_logo(leader):
    group = _group(leader)
    resp = APIClient().post(f"/v1/groups/{group.id}/logo", {}, format="multipart")
    assert resp.status_code == 401


def test_anonymous_gets_404_for_private_group_logo(leader):
    group = _group(leader, is_public=False)
    _upload(_client(leader), group.id, _png())
    assert APIClient().get(f"/v1/groups/{group.id}/logo").status_code == 404
    # Авторизованный (приглашаемый) логотип закрытого объединения видит.
    assert _client(_user("003")).get(f"/v1/groups/{group.id}/logo").status_code == 200


def test_no_logo_is_404(leader):
    group = _group(leader)
    assert APIClient().get(f"/v1/groups/{group.id}/logo").status_code == 404


def test_invalid_image_is_422(leader):
    group = _group(leader)
    resp = _upload(_client(leader), group.id, b"this is not an image")
    assert resp.status_code == 422, resp.content
    assert resp.data["code"] == "invalid_logo_image"


@override_settings(GROUP_LOGO_MAX_UPLOAD_BYTES=10)
def test_oversized_upload_is_413(leader):
    group = _group(leader)
    resp = _upload(_client(leader), group.id, _png())
    assert resp.status_code == 413, resp.content
    assert resp.data["code"] == "logo_too_large"
