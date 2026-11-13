"""Раздел «Поиск» (ADR-114): люди по @хендлу/телефону, объединения по
имени/@хендлу, гео-зоны world|country|city. Поиска по имени людей НЕТ by
design (ФИО зашифровано)."""

from __future__ import annotations

import pytest
from django.utils import timezone
from rest_framework.test import APIClient

from apps.accounts.models import User
from apps.dashboards import selectors
from apps.profiles.models import Profile
from apps.social import services as social_services
from apps.social.models import AddressableGroup

pytestmark = pytest.mark.django_db


def _user(suffix: str, *, country: str = "RU", phone_ok: bool = False) -> User:
    return User.objects.create(
        trust_id=f"trust-srch-{suffix}",
        phone=f"+7999094{suffix}",
        country_code=country,
        discoverable_by_handle=True,
        discoverable_by_phone=phone_ok,
    )


def _person(user: User, *, city: str = "", hidden: bool = False) -> Profile:
    return Profile.objects.create(
        kind=Profile.Kind.PERSON,
        owner_user=user,
        profile_visibility="public",
        city_name=city,
        hide_from_catalog=hidden,
    )


@pytest.fixture
def viewer():
    user = _user("0001", country="RU")
    _person(user, city="Алматы")
    return user


def test_handle_search_ignores_zone_exact_address(viewer):
    """Отсмотр 2026-08-24: хендл — адрес, зона к нему не применяется.
    Раньше дефолтная зона «город» отсекала всех с другим/пустым городом."""
    near = _user("0002")
    _person(near, city="Алматы")
    social_services.claim_handle(user=near, value="master_near")
    far = _user("0003")
    _person(far, city="Астана")
    social_services.claim_handle(user=far, value="master_far")

    result = selectors.get_search(viewer, query="master", zone="city")
    assert result["applied_zone"] == "city"
    assert {p["handle"] for p in result["profiles"]} == {"@master_near", "@master_far"}

    world = selectors.get_search(viewer, query="master", zone="world")
    assert {p["handle"] for p in world["profiles"]} == {"@master_near", "@master_far"}


def test_handle_search_finds_viewer_self(viewer):
    """«Ввожу свой хендл — не работает» — первый репро бага поиска."""
    social_services.claim_handle(user=viewer, value="me_myself")
    result = selectors.get_search(viewer, query="me_mys", zone="world")
    assert [p["handle"] for p in result["profiles"]] == ["@me_myself"]


def test_handle_search_with_and_without_at_prefix(viewer):
    other = _user("0009")
    _person(other, city="")
    social_services.claim_handle(user=other, value="manikur_pro")
    with_at = selectors.get_search(viewer, query="@manikur", zone="world")
    without_at = selectors.get_search(viewer, query="manikur", zone="world")
    assert [p["handle"] for p in with_at["profiles"]] == ["@manikur_pro"]
    assert [p["handle"] for p in without_at["profiles"]] == ["@manikur_pro"]


def test_default_zone_narrowest_available(viewer):
    result = selectors.get_search(viewer, query="whatever")
    assert result["applied_zone"] == "city"  # у зрителя заполнен город


def test_zone_falls_back_without_city():
    bare = _user("0004", country="DE")
    _person(bare, city="")
    result = selectors.get_search(bare, query="whatever", zone="city")
    assert result["applied_zone"] == "country"


def test_hidden_from_catalog_not_found(viewer):
    hidden = _user("0005")
    _person(hidden, city="Алматы", hidden=True)
    social_services.claim_handle(user=hidden, value="ghost_master")
    result = selectors.get_search(viewer, query="ghost", zone="world")
    assert result["profiles"] == []


def test_phone_search_requires_consent(viewer):
    allowed = _user("0006", phone_ok=True)
    _person(allowed, city="Астана")
    social_services.claim_handle(user=allowed, value="by_phone_ok")
    denied = _user("0007", phone_ok=False)
    _person(denied)

    hit = selectors.get_search(viewer, query=allowed.phone)
    assert [p["handle"] for p in hit["profiles"]] == ["@by_phone_ok"]
    # Вариант А (2026-08-24): телефонное совпадение помечено «номер не
    # подтверждён» — SMS-верификации пока нет.
    assert hit["profiles"][0]["phone_unverified"] is True

    miss = selectors.get_search(viewer, query=denied.phone)
    assert miss["profiles"] == []


def test_phone_search_ignores_catalog_hidden(viewer):
    """Согласие на находимость по телефону сильнее каталожного скрытия."""
    user = _user("0008", phone_ok=True)
    _person(user, hidden=True)
    hit = selectors.get_search(viewer, query=user.phone)
    assert len(hit["profiles"]) == 1


def test_groups_found_by_name_and_handle(viewer):
    leader = _user("0009")
    social_services.create_group(
        leader,
        kind=AddressableGroup.Kind.COMMUNITY,
        name="Плиточники Алматы",
        handle="tilers_almaty",
        sphere_code="it",
    )

    by_name = selectors.get_search(viewer, query="Плиточники")
    assert [g["name"] for g in by_name["groups"]] == ["Плиточники Алматы"]
    by_handle = selectors.get_search(viewer, query="@tilers")
    assert by_handle["groups"][0]["handle"] == "@tilers_almaty"
    assert by_handle["groups"][0]["members_count"] == 1


def test_http_shape(viewer):
    client = APIClient()
    client.force_authenticate(user=viewer)
    resp = client.get("/v1/dashboard/search", {"q": "ma", "zone": "world"})
    assert resp.status_code == 200, resp.content
    assert set(resp.data.keys()) == {"applied_zone", "profiles", "groups", "spheres", "catalog"}
    # Без фильтров каталога (план 11.09 §5) ветка catalog пустая — вторая
    # ветка не платит запросами, если её не спросили.
    assert resp.data["catalog"] == {"items": [], "next_cursor": None}
    # Короткий запрос — пустая выдача без похода в селектор.
    short = client.get("/v1/dashboard/search", {"q": "m"})
    assert short.data["profiles"] == [] and short.data["groups"] == []


# --- ADR-121: поиск по сферам (ADR-114 v2) -------------------------------------


def _sphere(code: str, name_ru: str, name_en: str):
    from apps.catalog.models import Sphere

    return Sphere.objects.get_or_create(
        code=code, defaults={"name_i18n": {"ru": name_ru, "en": name_en}, "is_active": True}
    )[0]


def test_sphere_query_finds_groups_by_sphere_with_geo(viewer):
    """«ищу мастера по маникюру в Москве — должна найти гильдии, кланы»:
    объединения по sphere_code, с учётом их географии и зоны зрителя
    (зритель: RU, Алматы)."""
    _sphere("beauty", "Красота", "Beauty")
    leader = _user("0010")
    social_services.create_group(
        leader,
        kind=AddressableGroup.Kind.GUILD,
        name="Мастера ногтевого сервиса",
        handle="nails_guild",
        sphere_code="beauty",
        geo_scope="city",
        country_code="RU",
        city_name="Алматы",
    )
    social_services.create_group(
        leader,
        kind=AddressableGroup.Kind.CLAN,
        name="Ногти Астаны",
        handle="nails_astana",
        sphere_code="beauty",
        geo_scope="city",
        country_code="RU",
        city_name="Астана",
    )
    social_services.create_group(
        leader,
        kind=AddressableGroup.Kind.COMMUNITY,
        name="Мировое сообщество красоты",
        handle="beauty_world",
        sphere_code="beauty",
        geo_scope="world",
    )

    city = selectors.get_search(viewer, query="красота", zone="city")
    assert [s["code"] for s in city["spheres"]] == ["beauty"]
    assert {g["name"] for g in city["groups"]} == {
        "Мастера ногтевого сервиса",
        "Мировое сообщество красоты",
    }
    assert all(g["sphere_code"] == "beauty" for g in city["groups"])

    country = selectors.get_search(viewer, query="красота", zone="country")
    assert {g["name"] for g in country["groups"]} == {
        "Мастера ногтевого сервиса",
        "Ногти Астаны",
        "Мировое сообщество красоты",
    }

    # Запрос-адрес сферу не резолвит: @хендл ищется как раньше, без сфер.
    by_handle = selectors.get_search(viewer, query="@nails_ast", zone="city")
    assert by_handle["spheres"] == []
    assert [g["handle"] for g in by_handle["groups"]] == ["@nails_astana"]


def test_sphere_query_finds_contractors_by_completed_deals(viewer):
    """Люди по сфере — только исполнители с завершёнными сделками в ней
    (репутация на фактах), с зоной и каталожной находимостью."""
    from apps.reputation.models import DealFact

    _sphere("beauty", "Красота", "Beauty")
    near = _user("0011")
    near_profile = _person(near, city="Алматы")
    social_services.claim_handle(user=near, value="nails_near")
    far = _user("0012")
    far_profile = _person(far, city="Астана")
    hidden = _user("0013")
    hidden_profile = _person(hidden, city="Алматы", hidden=True)
    for profile in (near_profile, far_profile, hidden_profile):
        DealFact.objects.create(
            contract_id=__import__("uuid").uuid4(),
            contractor_profile_id=profile.id,
            sphere_codes=["beauty"],
            is_completed=True,
            completed_at=timezone.now(),
        )

    city = selectors.get_search(viewer, query="красота", zone="city")
    assert [p["profile_id"] for p in city["profiles"]] == [str(near_profile.id)]
    assert city["profiles"][0]["sphere_match"] == "deals"
    assert city["profiles"][0]["handle"] == "@nails_near"

    country = selectors.get_search(viewer, query="красота", zone="country")
    assert {p["profile_id"] for p in country["profiles"]} == {
        str(near_profile.id),
        str(far_profile.id),
    }
    # hide_from_catalog — не в каталожной выдаче ни в одной зоне.
    assert str(hidden_profile.id) not in {p["profile_id"] for p in country["profiles"]}


def test_http_shape_includes_spheres(viewer):
    client = APIClient()
    client.force_authenticate(user=viewer)
    resp = client.get("/v1/dashboard/search", {"q": "ma", "zone": "world"})
    assert resp.status_code == 200
    assert set(resp.data.keys()) == {"applied_zone", "profiles", "groups", "spheres", "catalog"}


def test_remote_worker_is_world_geo_in_sphere_search(viewer):
    """«Работаю удалённо / из любого города» = «весь мир» у человека: находится
    по сфере из любой зоны (как world-объединение)."""
    from apps.reputation.models import DealFact

    _sphere("it", "IT", "IT")
    remote = _user("0014", country="DE")
    remote_profile = _person(remote, city="Берлин")
    remote_profile.works_remotely = True
    remote_profile.save(update_fields=["works_remotely"])
    DealFact.objects.create(
        contract_id=__import__("uuid").uuid4(),
        contractor_profile_id=remote_profile.id,
        sphere_codes=["it"],
        is_completed=True,
        completed_at=timezone.now(),
    )
    city = selectors.get_search(viewer, query="IT", zone="city")
    assert [p["profile_id"] for p in city["profiles"]] == [str(remote_profile.id)]


def test_declared_profile_spheres_found_and_marked(viewer):
    """ADR-122: заявленные в профиле сферы находятся с пометкой declared;
    факты сделок приоритетнее (deals) при совпадении обоих."""
    from apps.reputation.models import DealFact

    _sphere("beauty", "Красота", "Beauty")
    declared = _user("0015")
    declared_profile = _person(declared, city="Алматы")
    declared_profile.sphere_codes = ["beauty"]
    declared_profile.save(update_fields=["sphere_codes"])
    both = _user("0016")
    both_profile = _person(both, city="Алматы")
    both_profile.sphere_codes = ["beauty"]
    both_profile.save(update_fields=["sphere_codes"])
    DealFact.objects.create(
        contract_id=__import__("uuid").uuid4(),
        contractor_profile_id=both_profile.id,
        sphere_codes=["beauty"],
        is_completed=True,
        completed_at=timezone.now(),
    )

    result = selectors.get_search(viewer, query="красота", zone="city")
    by_id = {p["profile_id"]: p["sphere_match"] for p in result["profiles"]}
    assert by_id == {str(both_profile.id): "deals", str(declared_profile.id): "declared"}
