"""Объединения v2 (ADR-117): типы из книги, обязательные хендл и сфера,
география, ссылки, публичный просмотр. Каждый запрет — отдельным тестом."""

from __future__ import annotations

import pytest
from django.apps import apps as django_apps
from rest_framework.test import APIClient

from apps.accounts.models import User
from apps.social import selectors, services
from apps.social.models import AddressableGroup, GroupMembership, Handle

pytestmark = pytest.mark.django_db

_SPHERE = "it"  # активная сфера из сид-миграции каталога 0006


def _user(suffix: str) -> User:
    return User.objects.create(trust_id=f"trust-g2-{suffix}", phone=f"+7999094{suffix}")


@pytest.fixture
def leader() -> User:
    return _user("001")


def _group(leader: User, *, handle: str = "guild_x", **kwargs) -> AddressableGroup:
    defaults: dict = {
        "kind": AddressableGroup.Kind.GUILD,
        "name": "Гильдия мастеров",
        "sphere_code": _SPHERE,
    }
    defaults.update(kwargs)
    return services.create_group(leader, handle=handle, **defaults)


# --- создание: хендл обязателен и клеймится атомарно (§5) --------------------


def test_create_group_claims_handle(leader):
    group = _group(leader)
    handle = selectors.active_group_handle(group)
    assert handle is not None and handle.value == "guild_x"


def test_create_group_with_taken_handle_rolls_back(leader):
    services.claim_handle(user=leader, value="taken_one")
    with pytest.raises(services.HandleTakenError):
        _group(leader, handle="taken_one")
    # Вся регистрация объединения откатилась — ни группы, ни членства.
    assert AddressableGroup.objects.count() == 0
    assert GroupMembership.objects.count() == 0


def test_create_group_with_invalid_handle_format(leader):
    with pytest.raises(services.InvalidHandleFormatError):
        _group(leader, handle="ПоРукам!")
    assert AddressableGroup.objects.count() == 0


def test_group_still_has_exactly_one_active_handle_after_change(leader):
    """Смена хендла в настройках (§5): старый освобождается, активный один."""
    group = _group(leader)
    services.set_group_handle(group, leader, value="guild_renamed")
    active = Handle.objects.filter(group=group, is_active=True)
    assert [h.value for h in active] == ["guild_renamed"]


# --- сфера обязательна и из каталога (§2) ------------------------------------


def test_create_group_with_unknown_sphere(leader):
    with pytest.raises(services.InvalidGroupSphereError):
        _group(leader, sphere_code="no_such_sphere")


def test_create_group_with_empty_sphere(leader):
    with pytest.raises(services.InvalidGroupSphereError):
        _group(leader, sphere_code="")


def test_update_group_cannot_clear_sphere(leader):
    group = _group(leader)
    with pytest.raises(services.InvalidGroupSphereError):
        services.update_group(group, leader, sphere_code="")


# --- география (§3) ----------------------------------------------------------


def test_create_group_country_scope_requires_country_code(leader):
    with pytest.raises(services.InvalidGroupGeoError):
        _group(leader, geo_scope=AddressableGroup.GeoScope.COUNTRY)


def test_create_group_city_scope_requires_city_and_country(leader):
    with pytest.raises(services.InvalidGroupGeoError):
        _group(leader, geo_scope=AddressableGroup.GeoScope.CITY, country_code="KZ")


def test_create_group_city_scope_ok(leader):
    group = _group(
        leader,
        geo_scope=AddressableGroup.GeoScope.CITY,
        country_code="KZ",
        city_name="Алматы",
    )
    assert group.geo_scope == AddressableGroup.GeoScope.CITY


def test_update_group_geo_checked_against_final_state(leader):
    """Частичный PATCH только geo_scope=city без города — запрет по
    ИТОГОВОМУ состоянию строки."""
    group = _group(leader)
    with pytest.raises(services.InvalidGroupGeoError):
        services.update_group(group, leader, geo_scope=AddressableGroup.GeoScope.CITY)


# --- API: создание v2, алиасы kind (§1), ссылки (§4) -------------------------


def _auth_client(user: User) -> APIClient:
    client = APIClient()
    client.force_authenticate(user)
    return client


def test_api_create_group_v2_full(leader):
    resp = _auth_client(leader).post(
        "/v1/groups",
        {
            "kind": "guild",
            "name": "Гильдия",
            "handle": "api_guild",
            "sphere_code": _SPHERE,
            "geo_scope": "city",
            "country_code": "KZ",
            "city_name": "Алматы",
            "links": [{"url": "https://example.com/portfolio", "label": "Портфолио"}],
        },
        format="json",
    )
    assert resp.status_code == 201, resp.content
    assert resp.data["handle"] == "@api_guild"
    assert resp.data["sphere_code"] == _SPHERE
    assert resp.data["geo_scope"] == "city"
    assert resp.data["links"] == [{"url": "https://example.com/portfolio", "label": "Портфолио"}]
    assert resp.data["leader_name"] == ""


def test_api_create_group_kind_defaults_to_clan(leader):
    resp = _auth_client(leader).post(
        "/v1/groups",
        {"name": "Бригада", "handle": "brigade_1", "sphere_code": _SPHERE},
        format="json",
    )
    assert resp.status_code == 201, resp.content
    assert resp.data["kind"] == "clan"


@pytest.mark.parametrize(
    ("legacy", "mapped"),
    [("company_storefront", "company_showcase"), ("informal", "clan")],
)
def test_api_create_group_accepts_legacy_kind_alias(leader, legacy, mapped):
    resp = _auth_client(leader).post(
        "/v1/groups",
        {"kind": legacy, "name": "Легаси", "handle": f"legacy_{legacy}", "sphere_code": _SPHERE},
        format="json",
    )
    assert resp.status_code == 201, resp.content
    assert resp.data["kind"] == mapped


def test_api_create_group_without_handle_is_400(leader):
    resp = _auth_client(leader).post(
        "/v1/groups", {"name": "Без хендла", "sphere_code": _SPHERE}, format="json"
    )
    assert resp.status_code == 400, resp.content


def test_api_create_group_without_sphere_is_400(leader):
    resp = _auth_client(leader).post(
        "/v1/groups", {"name": "Без сферы", "handle": "nosphere"}, format="json"
    )
    assert resp.status_code == 400, resp.content


def test_api_create_group_unknown_sphere_is_422(leader):
    resp = _auth_client(leader).post(
        "/v1/groups",
        {"name": "Сфера-фантом", "handle": "ghost_sphere", "sphere_code": "no_such"},
        format="json",
    )
    assert resp.status_code == 422, resp.content
    assert resp.data["code"] == "invalid_sphere"


def test_api_create_group_taken_handle_is_409(leader):
    services.claim_handle(user=leader, value="dup_handle")
    resp = _auth_client(leader).post(
        "/v1/groups",
        {"name": "Дубль", "handle": "dup_handle", "sphere_code": _SPHERE},
        format="json",
    )
    assert resp.status_code == 409, resp.content
    assert resp.data["code"] == "handle_taken"


def test_api_create_group_too_many_links_is_400(leader):
    links = [{"url": f"https://example.com/{i}"} for i in range(11)]
    resp = _auth_client(leader).post(
        "/v1/groups",
        {"name": "Ссылки", "handle": "linky", "sphere_code": _SPHERE, "links": links},
        format="json",
    )
    assert resp.status_code == 400, resp.content


def test_api_create_group_bad_link_url_is_400(leader):
    resp = _auth_client(leader).post(
        "/v1/groups",
        {
            "name": "Ссылки",
            "handle": "linky2",
            "sphere_code": _SPHERE,
            "links": [{"url": "не-урл"}],
        },
        format="json",
    )
    assert resp.status_code == 400, resp.content


def test_api_incomplete_geo_is_422(leader):
    resp = _auth_client(leader).post(
        "/v1/groups",
        {"name": "Гео", "handle": "geo_bad", "sphere_code": _SPHERE, "geo_scope": "city"},
        format="json",
    )
    assert resp.status_code == 422, resp.content
    assert resp.data["code"] == "invalid_geo"


# --- публичный просмотр (§6) -------------------------------------------------


def test_anonymous_sees_public_group_card(leader):
    group = _group(leader)
    resp = APIClient().get(f"/v1/groups/{group.id}")
    assert resp.status_code == 200, resp.content
    assert resp.data["my_membership"] is None
    assert resp.data["members_count"] == 1


def test_anonymous_gets_404_for_private_group(leader):
    group = _group(leader, is_public=False)
    assert APIClient().get(f"/v1/groups/{group.id}").status_code == 404


def test_authenticated_sees_private_group(leader):
    """Приглашённому нужно видеть закрытое объединение до вступления."""
    group = _group(leader, is_public=False)
    resp = _auth_client(_user("010")).get(f"/v1/groups/{group.id}")
    assert resp.status_code == 200, resp.content


def test_anonymous_group_list_is_public(leader):
    _group(leader)
    resp = APIClient().get("/v1/groups")
    assert resp.status_code == 200, resp.content
    assert len(resp.data) == 1


def test_anonymous_cannot_create_group():
    resp = APIClient().post(
        "/v1/groups", {"name": "X", "handle": "anon_x", "sphere_code": _SPHERE}, format="json"
    )
    assert resp.status_code == 401


def test_anonymous_members_show_only_active(leader):
    group = _group(leader, join_policy=AddressableGroup.JoinPolicy.APPROVAL)
    services.join_group(group, _user("011"))  # requested — не публичен
    rows = APIClient().get(f"/v1/groups/{group.id}/members").data
    assert [row["role"] for row in rows] == ["leader"]


def test_manager_members_include_requests(leader):
    group = _group(leader, join_policy=AddressableGroup.JoinPolicy.APPROVAL)
    services.join_group(group, _user("012"))
    rows = _auth_client(leader).get(f"/v1/groups/{group.id}/members").data
    assert {row["status"] for row in rows} == {"active", "requested"}


def _person_profile_with_photo(user: User, *, visibility: str = "public"):
    """Профиль заводится через `apps.get_model`, а не импортом
    apps.profiles.models: apps.social (вместе с тестами) не имеет права
    импортировать apps.profiles — import-linter, «social зависит только от
    accounts»; сам сериализатор ходит туда через settings-селектор."""
    profile_model = django_apps.get_model("profiles", "Profile")
    return profile_model.objects.create(
        kind="person",
        owner_user=user,
        profile_visibility="public",
        avatar_visibility=visibility,
        avatar_key="avatars/leader/0198dd00",
    )


def test_member_row_carries_avatar(leader):
    """ADR-173: фото участника — тот же лид строки, что в разделах."""
    profile = _person_profile_with_photo(leader)
    group = _group(leader)
    rows = APIClient().get(f"/v1/groups/{group.id}/members").data
    assert str(profile.id) in rows[0]["member_avatar_url"]


def test_member_row_avatar_respects_deals_only(leader):
    """Видимость фото решает apps.profiles (ADR-103): гостю deals_only —
    null, а не ссылка; строка рисует инициалы."""
    _person_profile_with_photo(leader, visibility="deals_only")
    group = _group(leader)
    rows = APIClient().get(f"/v1/groups/{group.id}/members").data
    assert rows[0]["member_avatar_url"] is None


def test_member_row_links_to_reputation_card(leader):
    """member_handle/member_profile_id — участник кликабелен в карточку."""
    services.claim_handle(user=leader, value="leader_handle")
    group = _group(leader)
    rows = APIClient().get(f"/v1/groups/{group.id}/members").data
    assert rows[0]["member_handle"] == "@leader_handle"
    # person-профиля у голого User в этом тесте нет — поле честно null.
    assert "member_profile_id" in rows[0]
