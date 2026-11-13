"""`catalog` раздела `GET /dashboard/search` — план 11.09 §5, ADR-184:
каталожный поиск исполнителей. Гео на любом уровне (WorkArea, ADR-182),
сферы (ИЛИ внутри списка, заявленные ИЛИ подтверждённые завершённой
сделкой), опыт (число завершённых сделок ИСПОЛНИТЕЛЕМ), фильтры между
собой — И, keyset-пагинация. Каждая ветка покрытия гео и каждый фильтр —
отдельным тестом (CLAUDE.md).

ADR-193 (18.09): свой профиль зрителя исключён из выдачи, а при активном
гео-фильтре местные исполнители (`geo_match=local`) идут раньше тех, кто
виден только через `scope=world` (`geo_match=remote`, «работаю удалённо»,
ADR-184) — см. секции «Самоисключение зрителя» и «geo_match» ниже."""

from __future__ import annotations

import base64

import pytest
from django.utils import timezone
from rest_framework.test import APIClient

from apps.accounts.models import User
from apps.dashboards import selectors
from apps.geo.models import City, Country, Region
from apps.profiles.models import Profile, WorkArea
from apps.reputation.models import DealFact

pytestmark = pytest.mark.django_db

_counter = 0


def _user() -> User:
    global _counter
    _counter += 1
    return User.objects.create(
        trust_id=f"trust-cat-{_counter:04d}",
        phone=f"+7999077{_counter:04d}",
        discoverable_by_handle=True,
    )


def _profile(
    *,
    sphere_codes: list[str] | None = None,
    work_type_codes: list[str] | None = None,
    hidden: bool = False,
) -> Profile:
    return Profile.objects.create(
        kind=Profile.Kind.PERSON,
        owner_user=_user(),
        profile_visibility=Profile.Visibility.PUBLIC,
        hide_from_catalog=hidden,
        sphere_codes=sphere_codes or [],
        work_type_codes=work_type_codes or [],
    )


def _work_area(profile: Profile, **kwargs: object) -> WorkArea:
    return WorkArea.objects.create(profile=profile, **kwargs)


def _deal(profile: Profile, *, sphere_codes: list[str], role: str = "contractor") -> DealFact:
    global _counter
    _counter += 1
    kwargs = {
        "contract_id": f"00000000-0000-0000-0000-{_counter:012d}",
        "is_completed": True,
        "completed_at": timezone.now(),
        "sphere_codes": sphere_codes,
    }
    if role == "contractor":
        kwargs["contractor_profile_id"] = profile.id
        kwargs["customer_profile_id"] = _profile().id
    else:
        kwargs["customer_profile_id"] = profile.id
        kwargs["contractor_profile_id"] = _profile().id
    return DealFact.objects.create(**kwargs)


@pytest.fixture
def kz() -> Country:
    return Country.objects.create(code="KZ", is_active=True)


@pytest.fixture
def ru() -> Country:
    return Country.objects.create(code="RU", is_active=True)


@pytest.fixture
def almaty_region(kz: Country) -> Region:
    return Region.objects.create(
        country=kz, code="02", name="Алматинская область", name_latin="Almaty region"
    )


@pytest.fixture
def akmola_region(kz: Country) -> Region:
    return Region.objects.create(
        country=kz, code="01", name="Акмолинская область", name_latin="Akmola region"
    )


@pytest.fixture
def almaty_city(kz: Country, almaty_region: Region) -> City:
    return City.objects.create(
        country=kz, region=almaty_region, name="Алматы", name_latin="Almaty", geonames_id=1
    )


@pytest.fixture
def kokshetau_city(kz: Country, akmola_region: Region) -> City:
    return City.objects.create(
        country=kz, region=akmola_region, name="Кокшетау", name_latin="Kokshetau", geonames_id=2
    )


def _search(**kwargs: object) -> dict:
    """`viewer` по умолчанию — одноразовый зритель, не владеющий никаким из
    профилей теста (ADR-193: свой профиль исключается из выдачи, поэтому
    зритель ДОЛЖЕН быть кем-то посторонним для существующих сценариев,
    которые о самоисключении не думают); тесты самоисключения передают
    `viewer=` явно."""
    params = {
        "country": None,
        "region": None,
        "city": None,
        "sphere_codes": [],
        "work_type_codes": [],
        "min_experience": None,
    }
    params.update(kwargs)
    params.setdefault("viewer", _user())
    return selectors.get_search_catalog(**params)


def _ids(result: dict) -> set[str]:
    return {item["profile_id"] for item in result["items"]}


# --- Гео: покрытие уровня --------------------------------------------------


def test_no_geo_filter_is_whole_world(almaty_city: City):
    """Без гео-фильтра — «весь мир»: находится профиль с любым scope."""
    p = _profile()
    _work_area(p, scope=WorkArea.Scope.CITY, city=almaty_city)
    result = _search()
    assert str(p.id) in _ids(result)


def test_world_work_area_covers_city_filter(almaty_city: City):
    """`scope=world` покрывает любой запрошенный уровень (ADR-182: «работаю
    удалённо / из любого места»)."""
    p = _profile()
    _work_area(p, scope=WorkArea.Scope.WORLD)
    result = _search(city=almaty_city.id)
    assert str(p.id) in _ids(result)


def test_country_filter_finds_profile_declared_at_country_level(kz: Country):
    p = _profile()
    _work_area(p, scope=WorkArea.Scope.COUNTRY, country=kz)
    result = _search(country="KZ")
    assert str(p.id) in _ids(result)


def test_country_filter_does_not_find_a_different_country(kz: Country, ru: Country):
    p = _profile()
    _work_area(p, scope=WorkArea.Scope.COUNTRY, country=ru)
    result = _search(country="KZ")
    assert str(p.id) not in _ids(result)


def test_country_filter_covers_a_region_scoped_profile_inside_it(
    kz: Country, almaty_region: Region
):
    """«scope=country покрывает свои регионы/города» — но и обратное: поиск
    по всей стране обязан находить профиль, указавший только СВОЙ регион
    внутри неё (иначе он никогда не найдётся поиском по стране)."""
    p = _profile()
    _work_area(p, scope=WorkArea.Scope.REGION, region=almaty_region)
    result = _search(country="KZ")
    assert str(p.id) in _ids(result)


def test_country_filter_covers_a_city_scoped_profile_inside_it(kz: Country, almaty_city: City):
    p = _profile()
    _work_area(p, scope=WorkArea.Scope.CITY, city=almaty_city)
    result = _search(country="KZ")
    assert str(p.id) in _ids(result)


def test_region_filter_finds_city_scoped_profile_inside_the_region(
    almaty_region: Region, almaty_city: City
):
    """Постановка владельца (тест из ТЗ): «фильтр по региону находит профиль
    с scope=city внутри него»."""
    p = _profile()
    _work_area(p, scope=WorkArea.Scope.CITY, city=almaty_city)
    result = _search(region=f"KZ-{almaty_region.code}")
    assert str(p.id) in _ids(result)


def test_region_filter_does_not_find_a_sibling_region_city(
    almaty_region: Region, kokshetau_city: City
):
    """«…и не находит соседний [регион]» — та же страна, другой регион."""
    p = _profile()
    _work_area(p, scope=WorkArea.Scope.CITY, city=kokshetau_city)
    result = _search(region=f"KZ-{almaty_region.code}")
    assert str(p.id) not in _ids(result)


def test_region_filter_also_matches_country_scoped_profile(kz: Country, almaty_region: Region):
    """«scope=country покрывает свои регионы/города» — направление действует
    и когда запрос УЖЕ сузился до региона: профиль, указавший себя на всю
    страну, обязан находиться и поиском по региону внутри неё (иначе он
    вообще не появлялся бы в узких поисках, при этом широкий поиск по
    стране его находил бы — несогласованно)."""
    p = _profile()
    _work_area(p, scope=WorkArea.Scope.COUNTRY, country=kz)
    result = _search(region=f"KZ-{almaty_region.code}")
    assert str(p.id) in _ids(result)


def test_city_filter_finds_exact_city_scope(almaty_city: City):
    p = _profile()
    _work_area(p, scope=WorkArea.Scope.CITY, city=almaty_city)
    result = _search(city=almaty_city.id)
    assert str(p.id) in _ids(result)


def test_city_filter_does_not_find_a_different_city_in_the_same_region(
    almaty_region: Region, kz: Country
):
    other_city = City.objects.create(
        country=kz,
        region=almaty_region,
        name="Талдыкорган",
        name_latin="Taldykorgan",
        geonames_id=3,
    )
    target_city = City.objects.create(
        country=kz, region=almaty_region, name="Текели", name_latin="Tekeli", geonames_id=4
    )
    p = _profile()
    _work_area(p, scope=WorkArea.Scope.CITY, city=other_city)
    result = _search(city=target_city.id)
    assert str(p.id) not in _ids(result)


def test_unknown_city_id_yields_empty_geo_match_not_an_error(almaty_city: City):
    """Несуществующий id — пустая выдача, не 500/422 (тот же принцип, что
    у apps.geo.selectors.list_cities с плохим region=)."""
    p = _profile()
    _work_area(p, scope=WorkArea.Scope.WORLD)  # world всё равно матчит
    result = _search(city=999999)
    assert str(p.id) in _ids(result)  # world сработал
    p2 = _profile()
    _work_area(p2, scope=WorkArea.Scope.COUNTRY, country=Country.objects.create(code="FR"))
    result2 = _search(city=999999)
    assert str(p2.id) not in _ids(result2)


# --- Сферы ------------------------------------------------------------------


def test_declared_sphere_matches(almaty_city: City):
    p = _profile(sphere_codes=["cleaning"])
    result = _search(sphere_codes=["cleaning"])
    assert str(p.id) in _ids(result)


def test_sphere_or_between_multiple_codes():
    p_a = _profile(sphere_codes=["cleaning"])
    p_b = _profile(sphere_codes=["repair"])
    p_other = _profile(sphere_codes=["moving"])
    result = _search(sphere_codes=["cleaning", "repair"])
    ids = _ids(result)
    assert str(p_a.id) in ids
    assert str(p_b.id) in ids
    assert str(p_other.id) not in ids


def test_sphere_matches_via_completed_deal_as_contractor():
    p = _profile()
    _deal(p, sphere_codes=["repair"], role="contractor")
    result = _search(sphere_codes=["repair"])
    assert str(p.id) in _ids(result)


def test_sphere_does_not_match_completed_deal_as_customer_only():
    """«Опыт» — роль ИСПОЛНИТЕЛЯ; заказчик той же сферы не считается
    исполнителем этой сферы для каталога."""
    p = _profile()
    _deal(p, sphere_codes=["repair"], role="customer")
    result = _search(sphere_codes=["repair"])
    assert str(p.id) not in _ids(result)


def test_no_sphere_filter_ignores_spheres_entirely():
    p = _profile(sphere_codes=["anything"])
    result = _search(sphere_codes=[])
    assert str(p.id) in _ids(result)


# --- Виды работ (ADR-190, 12.09) -------------------------------------------


def test_declared_work_type_matches():
    p = _profile(work_type_codes=["repair.tiling"])
    result = _search(work_type_codes=["repair.tiling"])
    assert str(p.id) in _ids(result)


def test_work_type_or_between_multiple_codes():
    p_a = _profile(work_type_codes=["repair.tiling"])
    p_b = _profile(work_type_codes=["cleaning.windows"])
    p_other = _profile(work_type_codes=["moving.piano"])
    result = _search(work_type_codes=["repair.tiling", "cleaning.windows"])
    ids = _ids(result)
    assert str(p_a.id) in ids
    assert str(p_b.id) in ids
    assert str(p_other.id) not in ids


def test_no_work_type_filter_ignores_work_types_entirely():
    p = _profile(work_type_codes=["anything.here"])
    result = _search(work_type_codes=[])
    assert str(p.id) in _ids(result)


def test_work_type_does_not_match_via_completed_deal():
    """ТОЛЬКО заявленное — `DealFact` не несёт вида работ на уровне
    категории чек-листа (ADR-190 «Пределы задачи»), в отличие от сфер."""
    p = _profile()
    _deal(p, sphere_codes=["repair"], role="contractor")
    result = _search(work_type_codes=["repair.tiling"])
    assert str(p.id) not in _ids(result)


def test_work_type_combines_with_sphere_filter_as_and():
    """`sphere` и `work_type` — НЕЗАВИСИМЫЕ условия, комбинируются через И:
    профиль обязан удовлетворять ОБОИМ (ADR-190)."""
    both = _profile(sphere_codes=["repair"], work_type_codes=["repair.tiling"])
    only_sphere = _profile(sphere_codes=["repair"], work_type_codes=[])
    only_work_type = _profile(sphere_codes=[], work_type_codes=["repair.tiling"])
    result = _search(sphere_codes=["repair"], work_type_codes=["repair.tiling"])
    ids = _ids(result)
    assert ids == {str(both.id)}
    assert str(only_sphere.id) not in ids
    assert str(only_work_type.id) not in ids


# --- Опыт ---------------------------------------------------------------


def test_min_experience_excludes_profiles_below_threshold():
    p_experienced = _profile()
    _deal(p_experienced, sphere_codes=[])
    _deal(p_experienced, sphere_codes=[])
    p_new = _profile()
    result = _search(min_experience=2)
    ids = _ids(result)
    assert str(p_experienced.id) in ids
    assert str(p_new.id) not in ids


def test_min_experience_zero_still_includes_profiles_without_deals():
    p_new = _profile()
    result = _search(min_experience=0)
    assert str(p_new.id) in _ids(result)


def test_experience_only_counts_contractor_role_deals():
    p = _profile()
    _deal(p, sphere_codes=[], role="customer")
    result = _search(min_experience=1)
    assert str(p.id) not in _ids(result)


def test_completed_deals_count_reported_on_item():
    p = _profile()
    _deal(p, sphere_codes=[])
    _deal(p, sphere_codes=[])
    result = _search()
    item = next(i for i in result["items"] if i["profile_id"] == str(p.id))
    assert item["completed_deals_count"] == 2


# --- Комбинация фильтров (И) ----------------------------------------------


def test_filters_combine_with_and(kz: Country, almaty_city: City):
    """Гео И сфера И опыт — все три должны совпасть одновременно."""
    matches_all = _profile(sphere_codes=["cleaning"])
    _work_area(matches_all, scope=WorkArea.Scope.CITY, city=almaty_city)
    _deal(matches_all, sphere_codes=[])

    wrong_sphere = _profile(sphere_codes=["repair"])
    _work_area(wrong_sphere, scope=WorkArea.Scope.CITY, city=almaty_city)
    _deal(wrong_sphere, sphere_codes=[])

    wrong_geo = _profile(sphere_codes=["cleaning"])
    _work_area(wrong_geo, scope=WorkArea.Scope.COUNTRY, country=Country.objects.create(code="FR"))
    _deal(wrong_geo, sphere_codes=[])

    no_experience = _profile(sphere_codes=["cleaning"])
    _work_area(no_experience, scope=WorkArea.Scope.CITY, city=almaty_city)

    result = _search(city=almaty_city.id, sphere_codes=["cleaning"], min_experience=1)
    ids = _ids(result)
    assert ids == {str(matches_all.id)}


# --- Видимость (существующие правила каталога, не новые) -------------------


def test_hidden_from_catalog_profile_is_excluded():
    p = _profile(hidden=True)
    result = _search()
    assert str(p.id) not in _ids(result)


def test_non_discoverable_by_handle_profile_is_excluded():
    p = _profile()
    p.owner_user.discoverable_by_handle = False
    p.owner_user.save(update_fields=["discoverable_by_handle"])
    result = _search()
    assert str(p.id) not in _ids(result)


# --- Пагинация (keyset) -----------------------------------------------------


def test_pagination_walks_all_rows_without_duplicates_or_gaps():
    created = [_profile() for _ in range(7)]
    expected = {str(p.id) for p in created}

    collected: list[str] = []
    cursor = None
    pages = 0
    while True:
        page = _search(limit=3, cursor=cursor)
        collected.extend(item["profile_id"] for item in page["items"])
        cursor = page["next_cursor"]
        pages += 1
        if cursor is None:
            break
        assert pages < 20  # предохранитель от бесконечного цикла

    assert expected.issubset(set(collected))  # ни одна страница не потеряла наш профиль
    assert len(collected) == len(set(collected))  # и не задублировала


def test_pagination_walks_all_rows_with_work_type_filter_without_duplicates_or_gaps():
    """Пагинация не ломается в сочетании с фильтром по виду работ (ADR-190)."""
    matching = [_profile(work_type_codes=["repair.tiling"]) for _ in range(7)]
    for _ in range(5):
        _profile(work_type_codes=["cleaning.windows"])
    expected = {str(p.id) for p in matching}

    collected: list[str] = []
    cursor = None
    pages = 0
    while True:
        page = _search(limit=3, cursor=cursor, work_type_codes=["repair.tiling"])
        collected.extend(item["profile_id"] for item in page["items"])
        cursor = page["next_cursor"]
        pages += 1
        if cursor is None:
            break
        assert pages < 20

    assert set(collected) == expected
    assert len(collected) == len(set(collected))


def test_pagination_last_page_has_no_next_cursor():
    _profile()
    _profile()
    page = _search(limit=50)
    assert page["next_cursor"] is None


def test_invalid_cursor_raises() -> None:
    with pytest.raises(selectors.InvalidCatalogCursorError):
        _search(cursor="not-a-real-cursor!!")


# --- API-слой: параметры, валидация, wiring --------------------------------


def test_api_catalog_flag_triggers_world_wide_listing():
    viewer = _user()
    p = _profile()
    _work_area(p, scope=WorkArea.Scope.WORLD)
    client = APIClient()
    client.force_authenticate(user=viewer)
    resp = client.get("/v1/dashboard/search", {"catalog": "1"})
    assert resp.status_code == 200
    assert str(p.id) in {item["profile_id"] for item in resp.data["catalog"]["items"]}


def test_api_sphere_repeated_param_and_experience_filters(almaty_city: City):
    viewer = _user()
    match = _profile(sphere_codes=["cleaning"])
    _work_area(match, scope=WorkArea.Scope.WORLD)
    other = _profile(sphere_codes=["repair"])
    _work_area(other, scope=WorkArea.Scope.WORLD)
    client = APIClient()
    client.force_authenticate(user=viewer)
    resp = client.get("/v1/dashboard/search", {"sphere": ["cleaning", "moving"]})
    assert resp.status_code == 200
    ids = {item["profile_id"] for item in resp.data["catalog"]["items"]}
    assert str(match.id) in ids
    assert str(other.id) not in ids


def test_api_work_type_repeated_param_triggers_catalog_and_filters(almaty_city: City):
    """`work_type` — тоже флаг «включить catalog» (`_catalog_requested`),
    повторяемый параметр, ИЛИ между значениями (ADR-190)."""
    viewer = _user()
    match = _profile(work_type_codes=["repair.tiling"])
    _work_area(match, scope=WorkArea.Scope.WORLD)
    other = _profile(work_type_codes=["cleaning.windows"])
    _work_area(other, scope=WorkArea.Scope.WORLD)
    client = APIClient()
    client.force_authenticate(user=viewer)
    resp = client.get("/v1/dashboard/search", {"work_type": ["repair.tiling", "moving.piano"]})
    assert resp.status_code == 200
    ids = {item["profile_id"] for item in resp.data["catalog"]["items"]}
    assert str(match.id) in ids
    assert str(other.id) not in ids


def test_api_sphere_and_work_type_combine_as_and(almaty_city: City):
    viewer = _user()
    both = _profile(sphere_codes=["repair"], work_type_codes=["repair.tiling"])
    _work_area(both, scope=WorkArea.Scope.WORLD)
    only_sphere = _profile(sphere_codes=["repair"])
    _work_area(only_sphere, scope=WorkArea.Scope.WORLD)
    client = APIClient()
    client.force_authenticate(user=viewer)
    resp = client.get("/v1/dashboard/search", {"sphere": "repair", "work_type": "repair.tiling"})
    assert resp.status_code == 200
    ids = {item["profile_id"] for item in resp.data["catalog"]["items"]}
    assert ids == {str(both.id)}


def test_api_malformed_country_is_400():
    viewer = _user()
    client = APIClient()
    client.force_authenticate(user=viewer)
    resp = client.get("/v1/dashboard/search", {"country": "kazakhstan"})
    assert resp.status_code == 400


def test_api_malformed_region_is_400():
    viewer = _user()
    client = APIClient()
    client.force_authenticate(user=viewer)
    resp = client.get("/v1/dashboard/search", {"region": "not-a-region"})
    assert resp.status_code == 400


def test_api_malformed_city_is_400():
    viewer = _user()
    client = APIClient()
    client.force_authenticate(user=viewer)
    resp = client.get("/v1/dashboard/search", {"city": "not-an-int"})
    assert resp.status_code == 400


def test_api_invalid_cursor_is_400():
    viewer = _user()
    client = APIClient()
    client.force_authenticate(user=viewer)
    resp = client.get("/v1/dashboard/search", {"cursor": "!!broken"})
    assert resp.status_code == 400


def test_api_limit_over_max_is_400():
    viewer = _user()
    client = APIClient()
    client.force_authenticate(user=viewer)
    resp = client.get(
        "/v1/dashboard/search", {"catalog": "1", "limit": str(selectors.CATALOG_PAGE_SIZE_MAX + 1)}
    )
    assert resp.status_code == 400


def test_api_plain_q_search_unaffected_when_no_catalog_params():
    """Старый режим (q/zone) продолжает работать как раньше — catalog просто
    пустой (регресс уже проверен test_search.py::test_http_shape)."""
    viewer = _user()
    client = APIClient()
    client.force_authenticate(user=viewer)
    resp = client.get("/v1/dashboard/search", {"q": "whatever-nobody-has"})
    assert resp.status_code == 200
    assert resp.data["catalog"] == {"items": [], "next_cursor": None}


# --- Форма `location`: одно понятие — одно имя ключа ------------------------


def test_location_shape_matches_geo_serializers(
    kz: Country, almaty_region: Region, almaty_city: City
):
    """`location` каталожной выдачи повторяет форму `apps.geo` (и, значит,
    `/v1/profiles/{id}/work-areas`): страна — `{"code": …}` как у
    `CountrySerializer`, регион — составной `code` + `country`, город — `id`
    + `country` + составной `region`. Одно понятие не должно называться в
    двух эндпоинтах по-разному (находка приёмки 12.09)."""
    by_country = _profile()
    _work_area(by_country, scope=WorkArea.Scope.COUNTRY, country=kz)
    by_region = _profile()
    _work_area(by_region, scope=WorkArea.Scope.REGION, region=almaty_region)
    by_city = _profile()
    _work_area(by_city, scope=WorkArea.Scope.CITY, city=almaty_city)

    locations = {
        item["profile_id"]: item["work_areas"][0]["location"] for item in _search()["items"]
    }

    assert locations[str(by_country.id)] == {"code": "KZ"}

    region_location = locations[str(by_region.id)]
    assert region_location["code"] == "KZ-02"
    assert region_location["country"] == "KZ"
    assert region_location["display_name"] == "Алматинская область"

    city_location = locations[str(by_city.id)]
    assert city_location["id"] == almaty_city.id
    assert city_location["country"] == "KZ"
    assert city_location["region"] == "KZ-02"
    assert city_location["display_name"] == "Алматы"


def test_world_location_is_null():
    """`scope=world` — показывать нечего, `location` пустой (та же логика,
    что `WorkAreaSerializer.get_location`)."""
    p = _profile()
    _work_area(p, scope=WorkArea.Scope.WORLD)
    item = next(i for i in _search()["items"] if i["profile_id"] == str(p.id))
    assert item["work_areas"][0]["location"] is None


# --- Самоисключение зрителя (ADR-193, 18.09) --------------------------------
#
# Жалоба владельца (дословно): «выбрала например Армению, страну, где нет ни
# одного пользователя сейчас, он выдал всех из моей записной книги и плюс сам
# мой аккаунт».


def test_own_profile_is_excluded_from_catalog():
    viewer = _user()
    own = Profile.objects.create(
        kind=Profile.Kind.PERSON,
        owner_user=viewer,
        profile_visibility=Profile.Visibility.PUBLIC,
    )
    other = _profile()
    result = _search(viewer=viewer)
    ids = _ids(result)
    assert str(own.id) not in ids
    assert str(other.id) in ids


# --- geo_match: «местные первыми» (владелец 18.09, ADR-193) -----------------


def test_world_profile_is_remote_when_country_filter_has_no_local_matches():
    """Постановка владельца (дословно, 18.09): «выбрала например Армению,
    страну, где нет ни одного пользователя сейчас» — `scope=world` профиль
    всё ещё виден (ADR-184, by design), но помечен `remote`, не выдаётся за
    местного."""
    Country.objects.create(code="AM", is_active=True)
    p = _profile()
    _work_area(p, scope=WorkArea.Scope.WORLD)
    result = _search(country="AM")
    item = next(i for i in result["items"] if i["profile_id"] == str(p.id))
    assert item["geo_match"] == "remote"


def test_city_scoped_profile_is_local_within_country_filter(kz: Country, almaty_city: City):
    p = _profile()
    _work_area(p, scope=WorkArea.Scope.CITY, city=almaty_city)
    result = _search(country="KZ")
    item = next(i for i in result["items"] if i["profile_id"] == str(p.id))
    assert item["geo_match"] == "local"


def test_country_scoped_profile_is_local_within_country_filter(kz: Country):
    """`scope=country` — тоже РЕАЛЬНОЕ гео (не «работаю откуда угодно»),
    поэтому `local`, а не `remote`, даже когда запрос сам на уровне страны."""
    p = _profile()
    _work_area(p, scope=WorkArea.Scope.COUNTRY, country=kz)
    result = _search(country="KZ")
    item = next(i for i in result["items"] if i["profile_id"] == str(p.id))
    assert item["geo_match"] == "local"


def test_geo_match_is_null_without_geo_filter(almaty_city: City):
    p_world = _profile()
    _work_area(p_world, scope=WorkArea.Scope.WORLD)
    p_city = _profile()
    _work_area(p_city, scope=WorkArea.Scope.CITY, city=almaty_city)
    result = _search()
    assert result["items"]  # sanity: обе строки есть
    for item in result["items"]:
        assert item["geo_match"] is None


def test_local_profiles_come_before_remote_even_when_created_later(kz: Country, almaty_city: City):
    """Порядок группы побеждает порядок `created_at`: local, созданный
    РАНЬШЕ, обязан стоять выше remote, созданного ПОЗЖЕ (иначе местный
    тонет за страницами «мировых» флагов — ровно баг из жалобы владельца)."""
    local_p = _profile()
    _work_area(local_p, scope=WorkArea.Scope.CITY, city=almaty_city)
    remote_p = _profile()  # создан позже local_p
    _work_area(remote_p, scope=WorkArea.Scope.WORLD)

    result = _search(country="KZ")
    order = [item["profile_id"] for item in result["items"]]
    assert order.index(str(local_p.id)) < order.index(str(remote_p.id))


# --- Пагинация через границу local/remote (ADR-193) --------------------------


def test_pagination_keeps_local_before_remote_across_pages(kz: Country, almaty_city: City):
    locals_ = [_profile() for _ in range(3)]
    for p in locals_:
        _work_area(p, scope=WorkArea.Scope.CITY, city=almaty_city)
    remotes = [_profile() for _ in range(3)]
    for p in remotes:
        _work_area(p, scope=WorkArea.Scope.WORLD)
    expected = {str(p.id) for p in locals_} | {str(p.id) for p in remotes}

    collected: list[str] = []
    geo_matches: dict[str, str] = {}
    cursor = None
    pages = 0
    while True:
        page = _search(country="KZ", limit=1, cursor=cursor)
        for item in page["items"]:
            collected.append(item["profile_id"])
            geo_matches[item["profile_id"]] = item["geo_match"]
        cursor = page["next_cursor"]
        pages += 1
        if cursor is None:
            break
        assert pages < 20  # предохранитель от бесконечного цикла

    assert len(collected) == len(set(collected))  # ни потерь, ни дублей
    assert set(collected) == expected

    local_positions = [i for i, pid in enumerate(collected) if geo_matches[pid] == "local"]
    remote_positions = [i for i, pid in enumerate(collected) if geo_matches[pid] == "remote"]
    assert local_positions and remote_positions
    assert max(local_positions) < min(remote_positions)


def test_pagination_cursor_from_grouped_call_is_rejected_without_geo_filter():
    """Курсор, несущий группу `local`/`remote` (страница с активным
    гео-фильтром), несовместим с вызовом БЕЗ гео-фильтра (тот ждёт группу
    `none`) — рассинхронизация ловится как нечитаемый курсор (400), а не
    молча даёт неверный порядок."""
    p = _profile()
    crafted_cursor = selectors._encode_catalog_cursor(p, group="local")
    with pytest.raises(selectors.InvalidCatalogCursorError):
        _search(cursor=crafted_cursor)  # без гео-фильтра — группы нет, ждём "none"


def test_old_two_part_cursor_format_is_rejected():
    """Курсор старого (двухчастного, до ADR-193) формата — нечитаемый, а не
    молча неверно разобранный: явный 400, тот же путь, что у любого другого
    некорректного курсора."""
    p = _profile()
    old_style = (
        base64.urlsafe_b64encode(f"{p.created_at.isoformat()}|{p.id}".encode()).decode().rstrip("=")
    )
    with pytest.raises(selectors.InvalidCatalogCursorError):
        _search(cursor=old_style)
