"""Read-слой apps.profiles."""

from __future__ import annotations

from collections.abc import Iterable
from typing import Any

from django.db.models import Q, QuerySet, Subquery
from django.shortcuts import get_object_or_404

from apps.accounts import selectors as accounts_selectors
from apps.accounts.models import User
from apps.authority import selectors as authority_selectors
from apps.geo import selectors as geo_selectors
from apps.geo.models import City, Region

from .models import PortfolioPhoto, PortfolioProject, Profile, WorkArea


def list_catalog_profiles() -> QuerySet[Profile]:
    """Каталог/поиск (docs/tasks/etap-3-delta-adr059.md §2 тесты 5–6):
    бизнес-профили — всегда (гейт БД/сервиса уже держит их public), person —
    только profile_visibility=public И hide_from_catalog=False."""
    return Profile.objects.filter(
        Q(kind=Profile.Kind.BUSINESS)
        | Q(
            kind=Profile.Kind.PERSON,
            profile_visibility=Profile.Visibility.PUBLIC,
            hide_from_catalog=False,
        )
    )


def public_display_name(profile: Profile) -> str | None:
    """Отображаемое имя с уважением show_name (etap-3-delta-adr059.md §1.4:
    False = «только @handle» — имени не отдаём). Единая точка для карточки
    профиля (api/serializers) и обогащения уведомлений (ADR-098)."""
    if not profile.show_name:
        return None
    if profile.owner_user is not None:
        return accounts_selectors.get_full_name(profile.owner_user)
    if profile.owner_entity is not None:
        return profile.owner_entity.name
    return None


def is_visible_in_catalog(profile: Profile) -> bool:
    if profile.kind == Profile.Kind.BUSINESS:
        return True
    return profile.profile_visibility == Profile.Visibility.PUBLIC and not profile.hide_from_catalog


def profile_ids_with_declared_spheres(sphere_codes: list[str], *, limit: int = 100) -> list[Any]:
    """ADR-122/121: профили каталога, заявившие любую из сфер (JSON-список
    кодов, `contains` по одному коду — PostgreSQL jsonb @>). Только видимые в
    каталоге (`list_catalog_profiles`); порядок — свежие профили первыми."""
    if not sphere_codes:
        return []
    query = Q()
    for code in sphere_codes:
        query |= Q(sphere_codes__contains=[code])
    return list(
        list_catalog_profiles()
        .filter(query)
        .order_by("-created_at")
        .values_list("id", flat=True)[:limit]
    )


def declared_sphere_q(sphere_codes: list[str]) -> Q:
    """Та же семантика, что `profile_ids_with_declared_spheres` (JSONB
    `contains`, ИЛИ между кодами), но КАК `Q`, а не материализованный
    (обрезанный лимитом) список id — план 11.09 §5, ADR-184: каталожный
    поиск комбинирует это условие с гео/опытом на уровне ОДНОГО queryset'а
    с keyset-пагинацией, где обрезка id заранее сломала бы страницы."""
    query = Q()
    for code in sphere_codes:
        query |= Q(sphere_codes__contains=[code])
    return query


def declared_work_type_q(work_type_codes: list[str]) -> Q:
    """Фильтр каталожного поиска по видам работ (ADR-190, 12.09) — тот же
    приём, что `declared_sphere_q` (JSONB `contains`, ИЛИ между значениями).
    `work_type_codes` — составные коды `<сфера>.<категория>` РОВНО в том же
    формате, что хранит `Profile.work_type_codes` (services.update_profile),
    поэтому сравнение прямое, без разбора на части. ТОЛЬКО заявленное:
    в отличие от сфер (`contractor_sphere_deal_q`, факты завершённых
    сделок), у `DealFact` нет поля вида работ на уровне категории чек-листа
    (только `sphere_codes` дерева этапов целиком) — подтверждение сделкой
    для видов работ технически нечем посчитать без нового поля на
    `DealFact`, это сознательно НЕ сделано этой веткой (см. ADR-190
    «Пределы задачи»)."""
    query = Q()
    for code in work_type_codes:
        query |= Q(work_type_codes__contains=[code])
    return query


def _resolve_geo_coverage_target(
    *, country: str | None, region: str | None, city: int | None
) -> tuple[Any, Any, int | None] | None:
    """Разбор гео-параметров запроса в цель покрытия (страна/регион/город
    подзапроса `WorkArea`) — общая часть `geo_filter_coverage_q` и
    `geo_filter_local_coverage_q` (ADR-184, ADR-193): правило «что считать
    целью запроса» описано В ОДНОМ месте, обе публичные функции лишь
    по-разному собирают вокруг неё ветки `Q` (с `scope=world` или без).
    `None` — гео-фильтр не задан вовсе («весь мир», разбирать нечего).

    Если задано НЕСКОЛЬКО уровней сразу (страна+регион+город, как шлёт
    каскадный пикер) — побеждает САМЫЙ ГЛУБОКИЙ, более мелкие уровни
    игнорируются: это фильтр ЧТЕНИЯ, не запись `WorkArea` самого профиля
    (там `apps.profiles.services._resolve_work_area_item` шумно 422-ит на
    рассогласование — там человек описывает СЕБЯ и молчаливое исправление
    было бы обманом; здесь читатель описывает ЦЕЛЬ поиска, тихий приоритет
    глубины достаточен и проще).

    Несуществующий код/id — НЕ ошибка (в отличие от записи WorkArea):
    подзапрос просто ничего не находит → пустая выдача, тот же принцип, что
    у `apps.geo.selectors.list_cities` (плохой `region=` — пустой список,
    не 500/422); формат (`region=` не разбирается вовсе) — валидирует
    вызывающий api/views.py, что даёт понятный 400 до похода в БД."""
    target_country: Any
    target_region: Any
    target_city: int | None

    if city is not None:
        city_rows = City.objects.filter(pk=city, is_active=True)
        target_country = Subquery(city_rows.values("country_id")[:1])
        target_region = Subquery(city_rows.values("region_id")[:1])
        target_city = city
    elif region:
        region_country, local_code = geo_selectors.parse_region_code(region)
        region_rows = Region.objects.filter(
            country_id=region_country, code=local_code, is_active=True
        )
        target_country = Subquery(region_rows.values("country_id")[:1])
        target_region = Subquery(region_rows.values("id")[:1])
        target_city = None
    elif country:
        target_country = country.strip().upper()
        target_region = None
        target_city = None
    else:
        return None
    return target_country, target_region, target_city


def _geo_local_coverage_q(target: tuple[Any, Any, int | None]) -> Q:
    """Ветки `country`/`region`/`city` покрытия БЕЗ `scope=world` — общее
    тело `geo_filter_coverage_q`/`geo_filter_local_coverage_q` (ADR-193:
    второго определения правил покрытия в проекте быть не должно). Правило —
    «широкий масштаб покрывает всё, что внутри него»: `scope=country` —
    любой запрос внутри этой страны (сам уровень запроса может быть куда
    угодно глубже — страна/регион/город); `scope=region`/`scope=city` —
    только если совпадает их СОБСТВЕННЫЙ уровень запроса (или тот не задан
    вовсе: поиск по стране обязан находить и тех, кто указал только свой
    регион или город внутри неё)."""
    target_country, target_region, target_city = target

    covers = Q(scope=WorkArea.Scope.COUNTRY, country_id=target_country)

    region_q = Q(scope=WorkArea.Scope.REGION, region__country_id=target_country)
    if target_region is not None:
        region_q &= Q(region_id=target_region)
    covers |= region_q

    city_q = Q(scope=WorkArea.Scope.CITY, city__country_id=target_country)
    if target_region is not None:
        city_q &= Q(city__region_id=target_region)
    if target_city is not None:
        city_q &= Q(city_id=target_city)
    covers |= city_q

    return covers


def geo_filter_coverage_q(*, country: str | None, region: str | None, city: int | None) -> Q | None:
    """Q для `Profile.objects` (план 11.09 §5, ADR-184): у профиля есть
    `WorkArea`, покрывающий запрошенный уровень (включая `scope=world` —
    «работаю удалённо», ADR-182). `None` — гео-фильтр не задан вовсе («весь
    мир», фильтровать не нужно). Правило покрытия — см. `_geo_local_coverage_q`
    (эта функция лишь добавляет к нему ветку `scope=world`, которая матчит
    ЛЮБОЙ запрос)."""
    target = _resolve_geo_coverage_target(country=country, region=region, city=city)
    if target is None:
        return None
    covers = Q(scope=WorkArea.Scope.WORLD) | _geo_local_coverage_q(target)
    matching_profile_ids = WorkArea.objects.filter(covers).values("profile_id")
    return Q(pk__in=Subquery(matching_profile_ids))


def geo_filter_local_coverage_q(
    *, country: str | None, region: str | None, city: int | None
) -> Q | None:
    """«Местные первыми» (план владельца 18.09, ADR-193): то же покрытие,
    что `geo_filter_coverage_q`, но БЕЗ ветки `scope=world` — используется,
    чтобы отличить профиль, реально указавший гео уровня страна/регион/
    город (каталожный `geo_match=local`), от того, кто виден запросу ТОЛЬКО
    через «работаю удалённо» (`scope=world`, `geo_match=remote`; сам факт
    видимости remote-профиля в выдаче — by design, ADR-184, менять его эта
    ветка не должна, только порядок и пометку). `None` — гео-фильтр не
    задан (группировать нечего — `geo_match=null` у всех, см.
    `apps.dashboards.selectors.get_search_catalog`)."""
    target = _resolve_geo_coverage_target(country=country, region=region, city=city)
    if target is None:
        return None
    matching_profile_ids = WorkArea.objects.filter(_geo_local_coverage_q(target)).values(
        "profile_id"
    )
    return Q(pk__in=Subquery(matching_profile_ids))


def get_profile_or_none(profile_id: Any) -> Profile | None:
    """Профиль по id без 404 — для агрегатов, где id пришёл из read-модели
    другого контекста (ADR-121: DealFact.contractor_profile_id) и профиль
    мог быть удалён."""
    return Profile.objects.filter(pk=profile_id).select_related("owner_user").first()


def get_profile_or_404(profile_id: Any) -> Profile:
    """GET /profiles/{id} — ПРЯМОЙ доступ по id/ссылке НЕ фильтруется
    видимостью (docs/tasks/etap-3-delta-adr059.md §2 тест 5: link_and_deals
    недоступен в каталоге, но доступен по прямой ссылке/@handle — видимость
    гейтит только `list_catalog_profiles`, не эту функцию). «И контрагенту
    активного договора» — до apps.contracts (этап 4) не проверяется отдельно:
    прямой доступ и так не ограничен, ограничивать было бы нечего."""
    return get_object_or_404(Profile, pk=profile_id)


def get_person_profile_for_user(user: User) -> Profile | None:
    """Собственный person-профиль пользователя (или `None` — свежий аккаунт
    до шага «Профиль»). Композируется в `GET /handles/{handle}`
    (apps.social) через `settings.HANDLE_PUBLIC_PROFILE_SELECTOR` +
    `import_string` — тот же приём, что `list_for_user` ниже для
    `GET /users/me`: apps.social не имеет права импортировать apps.profiles
    (import-linter, «social зависит только от accounts»).

    Бизнес-профили сюда НЕ попадают намеренно: хендл принадлежит
    пользователю (`Handle.user`), а не юрлицу — «какой из бизнес-профилей
    этого пользователя» из хендла не выводится.
    """
    return Profile.objects.filter(owner_user=user, kind=Profile.Kind.PERSON).first()


def list_for_user(user: User) -> QuerySet[Profile]:
    """GET /users/me (etap-3.md 3.5 приёмка: «два профиля»): собственный
    person-профиль + бизнес-профили юрлиц, которые пользователь claim'нул
    ИЛИ где он активный представитель (facade apps.authority — Profile не
    хранит эту связь сам, её держит Representative)."""
    entity_ids = authority_selectors.entity_ids_represented_by(user)
    return Profile.objects.filter(
        Q(owner_user=user) | Q(owner_entity__claimed_by=user) | Q(owner_entity_id__in=entity_ids)
    ).distinct()


def can_act_as(user: User, profile_id: Any) -> bool:
    """apps.accounts.middleware.ActingProfileMiddleware (X-Acting-Profile,
    etap-3.md 3.5): «профиль мой ЛИБО юрлица, где я активный
    представитель» — КОНКРЕТНЫЙ permission проверяется отдельно, на уровне
    операции, не здесь (то же разделение, что has_active_representative /
    has_permission в apps.authority)."""
    profile = Profile.objects.filter(pk=profile_id).first()
    if profile is None:
        return False
    if profile.owner_user_id == user.id:
        return True
    if profile.owner_entity_id is None:
        return False
    return authority_selectors.has_active_representative(user, profile.owner_entity_id)


def list_work_areas(profile: Profile) -> QuerySet[WorkArea]:
    """GET /profiles/{id}/work-areas (план 11.09 §4, ADR-182) —
    `select_related` до объекта справочника И его родителя (город → его
    регион/страна для сериализации; регион → его страна) одним запросом,
    без N+1 на CitySerializer/RegionSerializer (те читают `obj.region`/
    `obj.country` — apps.geo.api.serializers)."""
    return profile.work_areas.select_related(
        "country", "region", "region__country", "city", "city__country", "city__region"
    ).order_by("created_at", "id")


def list_portfolio_projects(profile: Profile) -> QuerySet[PortfolioProject]:
    return PortfolioProject.objects.filter(portfolio__profile=profile)


def get_project_or_404(project_id: Any) -> PortfolioProject:
    return get_object_or_404(PortfolioProject, pk=project_id)


def get_project_photo_or_404(project: PortfolioProject, photo_id: Any) -> PortfolioPhoto:
    """ADR-120: фото строго внутри проекта из URL — чужой id не раскрывается."""
    return get_object_or_404(PortfolioPhoto, pk=photo_id, project=project)


# --- Фото профиля (ADR-103) ---------------------------------------------------

_AVATAR_SIGNER_SALT = "profiles.avatar"


def _avatar_signer() -> Any:
    from django.core import signing

    return signing.TimestampSigner(salt=_AVATAR_SIGNER_SALT)


def make_avatar_token(profile: Profile) -> str:
    """Подписанная ссылка для deals_only (ADR-103 п.4): <img> не шлёт
    Authorization, поэтому право зрителя фиксируется в самом URL. Подпись
    привязана к profile_id и текущему avatar_key — после замены/удаления
    фото старая ссылка не открывает новое."""
    return str(_avatar_signer().sign(f"{profile.id}:{profile.avatar_key}"))


def avatar_token_valid(profile: Profile, token: str | None) -> bool:
    from django.conf import settings
    from django.core import signing

    if not token:
        return False
    try:
        value = _avatar_signer().unsign(token, max_age=settings.PROFILE_AVATAR_URL_TTL_SECONDS)
    except signing.BadSignature:
        return False
    return bool(value == f"{profile.id}:{profile.avatar_key}")


def viewer_may_see_avatar(profile: Profile, *, viewer: User | None, viewer_profile_id: Any) -> bool:
    """public — любому; deals_only — владельцу/представителю (can_act_as) и
    контрагенту хотя бы одной завершённой сделки (apps.reputation через
    settings.PROFILE_AVATAR_COUNTERPARTY_SELECTOR — прямой импорт дал бы цикл
    profiles↔reputation)."""
    if profile.avatar_visibility == Profile.AvatarVisibility.PUBLIC:
        return True
    if viewer is not None and viewer.is_authenticated and can_act_as(viewer, profile.id):
        return True
    if viewer_profile_id is None:
        return False
    from django.conf import settings
    from django.utils.module_loading import import_string

    is_counterparty = import_string(settings.PROFILE_AVATAR_COUNTERPARTY_SELECTOR)
    return bool(is_counterparty(profile.id, viewer_profile_id))


def avatar_url(profile: Profile, *, allowed: bool, size: int = 256) -> str | None:
    """`avatar_url` для сериализаторов: None — фото нет или зрителю нельзя.
    `v` — cache-buster (хвост avatar_key, uuid7 загрузки), `t` — подпись,
    только для deals_only (public отдаётся и без неё)."""
    if not profile.avatar_key or not allowed:
        return None
    from django.urls import reverse

    base = reverse("profile-avatar", kwargs={"profile_id": profile.id})
    version = profile.avatar_key.rsplit("/", 1)[-1][:12]
    url = f"{base}?size={size}&v={version}"
    if profile.avatar_visibility != Profile.AvatarVisibility.PUBLIC:
        url += f"&t={make_avatar_token(profile)}"
    return url


def avatar_url_for_request(profile: Profile, request: Any, *, size: int = 256) -> str | None:
    """Зритель — из DRF request (JWT + X-Acting-Profile, ActingProfileMiddleware);
    без request (сериализатор без context) — только public.

    Фото нет — выходим ДО проверки права: у `deals_only` она ходит в БД
    (`PROFILE_AVATAR_COUNTERPARTY_SELECTOR`), а ответ всё равно None. В
    лентах и разделах (ADR-173) профилей без фото большинство — эта ветка
    держит число запросов постоянным."""
    if not profile.avatar_key:
        return None
    if request is None:
        viewer, viewer_profile_id = None, None
    else:
        user = getattr(request, "user", None)
        viewer = user if user is not None and user.is_authenticated else None
        viewer_profile_id = (
            getattr(request, "acting_profile_id", None) if viewer is not None else None
        )
    allowed = viewer_may_see_avatar(profile, viewer=viewer, viewer_profile_id=viewer_profile_id)
    return avatar_url(profile, allowed=allowed, size=size)


def avatar_urls_for_request(
    profile_ids: Iterable[Any], request: Any, *, size: int = 256
) -> dict[str, str | None]:
    """ADR-173: фото контрагентов ПАЧКОЙ — один запрос за профилями, по
    одному разрешению на профиль. Для лент/агрегатов, где на руках только
    `profile_id` (лента уведомлений хранит его в payload). Ключи — строки
    id; профиля с таким id нет — ключа в ответе нет."""
    ids = {str(pid) for pid in profile_ids if pid}
    if not ids:
        return {}
    return {
        str(profile.id): avatar_url_for_request(profile, request, size=size)
        for profile in Profile.objects.filter(pk__in=ids)
    }
