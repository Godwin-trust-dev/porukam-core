"""Портфолио объединения (ADR-128): CRUD проектов и галерея фото под
рубежом leader/admin, публичная витрина, каждый запрет — отдельным тестом.

Пайплайн байтов — common/images + common/object_store (тот же, что логотип
ADR-117 §8 и личное портфолио ADR-115/ADR-120), поэтому здесь проверяется
не сама нормализация, а границы: права, скоуп по объединению, лимит фото,
видимость закрытого объединения, физическое удаление объектов."""

from __future__ import annotations

import io
from datetime import date

import pytest
from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import override_settings
from PIL import Image
from rest_framework.test import APIClient

from apps.accounts.models import User
from apps.social import services
from apps.social.models import AddressableGroup, GroupMembership, GroupPortfolioProject
from apps.social.storage import build_group_media_store, reset_fake_store

pytestmark = pytest.mark.django_db


@pytest.fixture(autouse=True)
def _clean_store():
    reset_fake_store()
    yield
    reset_fake_store()


def _png(width: int = 400, height: int = 300) -> bytes:
    image = Image.new("RGB", (width, height), (10, 160, 90))
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return buffer.getvalue()


def _user(suffix: str) -> User:
    return User.objects.create(trust_id=f"trust-gp-{suffix}", phone=f"+7999096{suffix}")


@pytest.fixture
def leader() -> User:
    return _user("001")


def _group(leader: User, *, handle: str = "gp_guild", **kwargs) -> AddressableGroup:
    defaults: dict = {
        "kind": AddressableGroup.Kind.GUILD,
        "name": "Гильдия с витриной работ",
        "sphere_code": "it",
    }
    defaults.update(kwargs)
    return services.create_group(leader, handle=handle, **defaults)


def _client(user: User | None = None) -> APIClient:
    client = APIClient()
    if user is not None:
        client.force_authenticate(user)
    return client


def _admin_of(group: AddressableGroup, suffix: str) -> User:
    """Админ — участник с ролью admin: право на витрину равно праву на логотип."""
    user = _user(suffix)
    services.join_group(group, user)
    membership = GroupMembership.objects.get(group=group, member=user)
    membership.role = GroupMembership.Role.ADMIN
    membership.save(update_fields=["role"])
    return user


_PAYLOAD = {
    "title": "Витрина интернет-магазина",
    "description": "Сделали каталог и корзину, запустили за два месяца.",
    "completed_at": "2026-05-20",
    "started_at": "2026-03-01",
    "location_label": "Алматы",
}


def _projects_url(group: AddressableGroup) -> str:
    return f"/v1/groups/{group.id}/portfolio/projects"


def _create(client: APIClient, group: AddressableGroup, **overrides):
    payload = dict(_PAYLOAD)
    payload.update(overrides)
    return client.post(_projects_url(group), payload, format="json")


def _project(leader: User, group: AddressableGroup) -> GroupPortfolioProject:
    resp = _create(_client(leader), group)
    assert resp.status_code == 201, resp.content
    return GroupPortfolioProject.objects.get(pk=resp.data["id"])


def _upload(
    client: APIClient, project: GroupPortfolioProject, content: bytes, name: str = "work.png"
):
    return client.post(
        f"/v1/groups/{project.group_id}/portfolio/projects/{project.id}/photos",
        {"file": SimpleUploadedFile(name, content, content_type="image/png")},
        format="multipart",
    )


# --- создание проекта ---------------------------------------------------------


def test_leader_creates_project_and_sphere_defaults_to_group_sphere(leader):
    group = _group(leader)
    resp = _create(_client(leader), group, sphere_code="")
    assert resp.status_code == 201, resp.content
    assert resp.data["title"] == _PAYLOAD["title"]
    assert resp.data["started_at"] == "2026-03-01"
    assert resp.data["completed_at"] == "2026-05-20"
    assert resp.data["location_label"] == "Алматы"
    # Пустая сфера — берём сферу самого объединения, а не пустую строку.
    assert resp.data["sphere_code"] == "it"
    assert resp.data["photos"] == []
    assert resp.data["photo_url"] is None


def test_admin_can_create_project(leader):
    group = _group(leader)
    admin = _admin_of(group, "002")
    assert _create(_client(admin), group).status_code == 201


def test_member_cannot_create_project(leader):
    group = _group(leader)
    member = _user("003")
    services.join_group(group, member)
    resp = _create(_client(member), group)
    assert resp.status_code == 403, resp.content
    assert resp.data["code"] == "permission_denied"


def test_outsider_cannot_create_project(leader):
    group = _group(leader)
    resp = _create(_client(_user("004")), group)
    assert resp.status_code == 403, resp.content


def test_anonymous_cannot_create_project(leader):
    group = _group(leader)
    assert _create(_client(), group).status_code == 401


def test_completed_at_is_required(leader):
    group = _group(leader)
    resp = _client(leader).post(_projects_url(group), {"title": "Без даты"}, format="json")
    assert resp.status_code == 400, resp.content


def test_started_after_completed_is_422(leader):
    group = _group(leader)
    resp = _create(_client(leader), group, started_at="2026-06-01", completed_at="2026-05-20")
    assert resp.status_code == 422, resp.content
    assert resp.data["code"] == "portfolio_dates_invalid"


def test_unknown_sphere_code_is_422(leader):
    group = _group(leader)
    resp = _create(_client(leader), group, sphere_code="нет-такой-сферы")
    assert resp.status_code == 422, resp.content
    assert resp.data["code"] == "invalid_sphere"


# --- чтение витрины -----------------------------------------------------------


def test_anyone_reads_public_group_portfolio(leader):
    group = _group(leader)
    _project(leader, group)
    resp = _client().get(_projects_url(group))
    assert resp.status_code == 200, resp.content
    assert [row["title"] for row in resp.data] == [_PAYLOAD["title"]]


def test_anonymous_cannot_read_private_group_portfolio(leader):
    group = _group(leader, handle="gp_closed", is_public=False)
    _project(leader, group)
    # Витрина закрытого объединения не видна анониму — как сама карточка (404, не 403).
    assert _client().get(_projects_url(group)).status_code == 404
    assert _client(_user("005")).get(_projects_url(group)).status_code == 200


def test_project_of_another_group_is_404(leader):
    group = _group(leader)
    other = _group(_user("006"), handle="gp_other")
    project = _project(leader, group)
    resp = _client(leader).get(f"/v1/groups/{other.id}/portfolio/projects/{project.id}")
    assert resp.status_code == 404, resp.content


def test_single_project_is_public(leader):
    group = _group(leader)
    project = _project(leader, group)
    resp = _client().get(f"/v1/groups/{group.id}/portfolio/projects/{project.id}")
    assert resp.status_code == 200, resp.content
    assert resp.data["description"] == _PAYLOAD["description"]


# --- редактирование -----------------------------------------------------------


def test_leader_edits_project(leader):
    group = _group(leader)
    project = _project(leader, group)
    resp = _client(leader).patch(
        f"/v1/groups/{group.id}/portfolio/projects/{project.id}",
        {"title": "Новое название", "location_label": "Астана"},
        format="json",
    )
    assert resp.status_code == 200, resp.content
    assert resp.data["title"] == "Новое название"
    assert resp.data["location_label"] == "Астана"


def test_patch_null_started_at_clears_it(leader):
    group = _group(leader)
    project = _project(leader, group)
    resp = _client(leader).patch(
        f"/v1/groups/{group.id}/portfolio/projects/{project.id}",
        {"started_at": None},
        format="json",
    )
    assert resp.status_code == 200, resp.content
    assert resp.data["started_at"] is None


def test_patch_with_invalid_dates_is_422(leader):
    group = _group(leader)
    project = _project(leader, group)
    resp = _client(leader).patch(
        f"/v1/groups/{group.id}/portfolio/projects/{project.id}",
        {"started_at": "2026-09-01"},
        format="json",
    )
    assert resp.status_code == 422, resp.content
    assert resp.data["code"] == "portfolio_dates_invalid"


def test_member_cannot_edit_project(leader):
    group = _group(leader)
    project = _project(leader, group)
    member = _user("007")
    services.join_group(group, member)
    resp = _client(member).patch(
        f"/v1/groups/{group.id}/portfolio/projects/{project.id}",
        {"title": "Чужими руками"},
        format="json",
    )
    assert resp.status_code == 403, resp.content


def test_anonymous_cannot_edit_project(leader):
    group = _group(leader)
    project = _project(leader, group)
    resp = _client().patch(
        f"/v1/groups/{group.id}/portfolio/projects/{project.id}",
        {"title": "Аноним"},
        format="json",
    )
    assert resp.status_code == 401


# --- удаление -----------------------------------------------------------------


def test_leader_deletes_project_with_photo_objects(leader):
    group = _group(leader)
    project = _project(leader, group)
    assert _upload(_client(leader), project, _png()).status_code == 201
    project.refresh_from_db()
    key = project.photo_key

    resp = _client(leader).delete(f"/v1/groups/{group.id}/portfolio/projects/{project.id}")
    assert resp.status_code == 204, resp.content
    assert not GroupPortfolioProject.objects.filter(pk=project.pk).exists()
    # Байты удаляются физически — витрина не юрзначима, восстановления нет.
    store = build_group_media_store()
    assert store.get(services.group_portfolio_object_key(key, 1280)) is None
    assert store.get(services.group_portfolio_object_key(key, 320)) is None


def test_member_cannot_delete_project(leader):
    group = _group(leader)
    project = _project(leader, group)
    member = _user("008")
    services.join_group(group, member)
    resp = _client(member).delete(f"/v1/groups/{group.id}/portfolio/projects/{project.id}")
    assert resp.status_code == 403, resp.content
    assert GroupPortfolioProject.objects.filter(pk=project.pk).exists()


def test_anonymous_cannot_delete_project(leader):
    group = _group(leader)
    project = _project(leader, group)
    assert (
        _client().delete(f"/v1/groups/{group.id}/portfolio/projects/{project.id}").status_code
        == 401
    )


# --- фото ---------------------------------------------------------------------


def test_first_photo_becomes_primary_and_is_served_without_crop(leader):
    group = _group(leader)
    project = _project(leader, group)
    resp = _upload(_client(leader), project, _png(800, 600))
    assert resp.status_code == 201, resp.content
    assert len(resp.data["photos"]) == 1
    assert resp.data["photos"][0]["is_primary"] is True
    assert resp.data["photo_url"] == resp.data["photos"][0]["url"]
    assert "v=" in resp.data["photo_url"]

    got = _client().get(resp.data["photos"][0]["url"])
    assert got.status_code == 200, got.content
    assert got["Content-Type"] == "image/webp"
    # Аспект сохраняется (в отличие от квадратного логотипа): 800×600 не апскейлится.
    assert Image.open(io.BytesIO(got.content)).size == (800, 600)


def test_grid_size_variant_is_served(leader):
    group = _group(leader)
    project = _project(leader, group)
    url = _upload(_client(leader), project, _png(1600, 1200)).data["photos"][0]["url"]
    got = _client().get(f"{url}&size=320")
    assert got.status_code == 200
    assert Image.open(io.BytesIO(got.content)).size == (320, 240)
    # Неизвестный размер — молча падаем на первый (1280), а не 400.
    assert Image.open(io.BytesIO(_client().get(f"{url}&size=999").content)).size == (1280, 960)


def test_sixth_photo_is_409(leader):
    group = _group(leader)
    project = _project(leader, group)
    for _ in range(services.GROUP_PORTFOLIO_MAX_PHOTOS):
        assert _upload(_client(leader), project, _png()).status_code == 201
    resp = _upload(_client(leader), project, _png())
    assert resp.status_code == 409, resp.content
    assert resp.data["code"] == "portfolio_photos_limit"


def test_invalid_image_is_422(leader):
    group = _group(leader)
    project = _project(leader, group)
    resp = _upload(_client(leader), project, "это не картинка".encode())
    assert resp.status_code == 422, resp.content
    assert resp.data["code"] == "invalid_portfolio_image"


@override_settings(GROUP_PORTFOLIO_MAX_UPLOAD_BYTES=10)
def test_oversized_photo_is_413(leader):
    group = _group(leader)
    project = _project(leader, group)
    resp = _upload(_client(leader), project, _png())
    assert resp.status_code == 413, resp.content
    assert resp.data["code"] == "portfolio_photo_too_large"


def test_set_primary_reorders_gallery(leader):
    group = _group(leader)
    project = _project(leader, group)
    _upload(_client(leader), project, _png(400, 300))
    second = _upload(_client(leader), project, _png(500, 400)).data["photos"][1]

    resp = _client(leader).post(
        f"/v1/groups/{group.id}/portfolio/projects/{project.id}/photos/{second['id']}/primary"
    )
    assert resp.status_code == 200, resp.content
    assert resp.data["photos"][0]["id"] == second["id"]
    assert resp.data["photos"][0]["is_primary"] is True
    assert resp.data["photo_url"] == resp.data["photos"][0]["url"]


def test_delete_photo_promotes_next_and_removes_objects(leader):
    group = _group(leader)
    project = _project(leader, group)
    first = _upload(_client(leader), project, _png(400, 300)).data["photos"][0]
    second = _upload(_client(leader), project, _png(500, 400)).data["photos"][1]
    project.refresh_from_db()
    first_key = project.photo_key

    resp = _client(leader).delete(
        f"/v1/groups/{group.id}/portfolio/projects/{project.id}/photos/{first['id']}"
    )
    assert resp.status_code == 200, resp.content
    assert [row["id"] for row in resp.data["photos"]] == [second["id"]]
    assert resp.data["photos"][0]["order"] == 0
    assert resp.data["photos"][0]["is_primary"] is True
    assert (
        build_group_media_store().get(services.group_portfolio_object_key(first_key, 1280)) is None
    )


def test_last_photo_removal_clears_cover(leader):
    group = _group(leader)
    project = _project(leader, group)
    photo = _upload(_client(leader), project, _png()).data["photos"][0]
    resp = _client(leader).delete(
        f"/v1/groups/{group.id}/portfolio/projects/{project.id}/photos/{photo['id']}"
    )
    assert resp.status_code == 200, resp.content
    assert resp.data["photos"] == []
    assert resp.data["photo_url"] is None
    project.refresh_from_db()
    assert project.photo_key == ""


def test_photo_of_another_project_is_404(leader):
    group = _group(leader)
    project = _project(leader, group)
    other = _project(leader, group)
    photo = _upload(_client(leader), project, _png()).data["photos"][0]
    resp = _client(leader).delete(
        f"/v1/groups/{group.id}/portfolio/projects/{other.id}/photos/{photo['id']}"
    )
    assert resp.status_code == 404, resp.content


def test_member_cannot_touch_photos(leader):
    group = _group(leader)
    project = _project(leader, group)
    photo = _upload(_client(leader), project, _png()).data["photos"][0]
    member = _user("009")
    services.join_group(group, member)
    base = f"/v1/groups/{group.id}/portfolio/projects/{project.id}"
    assert _upload(_client(member), project, _png()).status_code == 403
    assert _client(member).delete(f"{base}/photos/{photo['id']}").status_code == 403
    assert _client(member).post(f"{base}/photos/{photo['id']}/primary").status_code == 403


def test_anonymous_cannot_touch_photos(leader):
    group = _group(leader)
    project = _project(leader, group)
    photo = _upload(_client(leader), project, _png()).data["photos"][0]
    base = f"/v1/groups/{group.id}/portfolio/projects/{project.id}"
    assert _upload(_client(), project, _png()).status_code == 401
    assert _client().delete(f"{base}/photos/{photo['id']}").status_code == 401
    assert _client().post(f"{base}/photos/{photo['id']}/primary").status_code == 401


def test_anonymous_cannot_get_photo_of_private_group(leader):
    group = _group(leader, handle="gp_hidden", is_public=False)
    project = _project(leader, group)
    url = _upload(_client(leader), project, _png()).data["photos"][0]["url"]
    assert _client().get(url).status_code == 404
    # Авторизованный (приглашаемый) витрину закрытого объединения видит.
    assert _client(_user("010")).get(url).status_code == 200


# --- сервисный слой -----------------------------------------------------------


def test_service_requires_completed_at(leader):
    group = _group(leader)
    with pytest.raises(services.GroupPortfolioDatesInvalidError):
        services.create_group_portfolio_project(group, leader, title="Без даты")


def test_service_rejects_non_manager(leader):
    group = _group(leader)
    member = _user("011")
    services.join_group(group, member)
    with pytest.raises(services.GroupPermissionDeniedError):
        services.create_group_portfolio_project(
            group, member, title="Мимо", completed_at=date(2026, 5, 1)
        )
