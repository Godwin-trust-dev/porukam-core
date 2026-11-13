"""Use cases apps.profiles (tech-spec.md §5.2.3, §8.3; domain-model.md §3.3,
§3.4; docs/tasks/etap-3.md 3.5; docs/tasks/etap-3-delta-adr059.md §1.4, §2
тест 4)."""

from __future__ import annotations

import logging
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

from django.conf import settings
from django.db import transaction
from django.db.models import Q
from django.utils import timezone

from apps.accounts.models import User
from apps.authority import selectors as authority_selectors
from apps.authority.models import Representative
from apps.catalog import selectors as catalog_selectors
from apps.entities import services as entities_services
from apps.entities.models import BusinessEntity
from apps.geo import selectors as geo_selectors
from apps.geo.models import City, Country, Region
from common.uuid7 import uuid7

from .images import (
    AVATAR_CONTENT_TYPE,
    AVATAR_SIZES,
    PORTFOLIO_SIZES,
    InvalidAvatarImageError,
    process_avatar,
    process_portfolio_image,
)
from .models import Portfolio, PortfolioPhoto, PortfolioProject, Profile, WorkArea
from .storage import AvatarObjectStore, build_avatar_store

logger = logging.getLogger(__name__)


_UNSET: Any = object()


PROFILE_MAX_SPHERES = 10
# ADR-190 (12.09): 3× лимита сфер — по несколько видов работ на заявленную
# сферу (до 10 сфер), не «без ограничения»; ровно как лимит сфер — уровень
# сервиса, не БД (константу можно поменять без миграции).
PROFILE_MAX_WORK_TYPES = 30


class ProfileSpheresInvalidError(ValueError):
    """ADR-122: неизвестный/неактивный код сферы каталога."""


class ProfileSpheresLimitError(ValueError):
    """ADR-122: больше PROFILE_MAX_SPHERES сфер."""


class ProfileWorkTypesInvalidError(ValueError):
    """ADR-190: неверный формат составного кода, либо код не отвечает
    `catalog_selectors.is_selectable_work_type` (нет текущих пунктов
    чек-листа или нет подписи ни в ru, ни в en — та же логика, что исключает
    4 кода `other.*` из GET /work-types)."""


class ProfileWorkTypesLimitError(ValueError):
    """ADR-190: больше PROFILE_MAX_WORK_TYPES видов работ."""


class ProfileWorkTypeSphereNotDeclaredError(ValueError):
    """ADR-190: вид работ ссылается на сферу, которой нет в sphere_codes
    ЭТОГО профиля — «нельзя выбрать вид работ из сферы, которую не заявил»
    (постановка владельца 12.09, разбор docs/backlog.md)."""


class ProfileVisibilityLockedError(ValueError):
    """Бизнес-профиль игнорирует настройки видимости — всегда PUBLIC, пока
    операбелен (docs/tasks/etap-3-delta-adr059.md Р5). Тот же приём, что
    apps.notifications.services.InAppChannelCannotBeDisabledError — доменная
    ошибка ДО записи, а не IntegrityError от CheckConstraint."""


class ProfilePermissionDeniedError(ValueError):
    """Редактировать профиль/портфолио может владелец либо представитель с
    permission MANAGE_PROFILE (для бизнес-профиля)."""


class AvatarTooLargeError(ValueError):
    """Файл больше settings.PROFILE_AVATAR_MAX_UPLOAD_BYTES (ADR-103 п.7)."""


class PortfolioDatesInvalidError(ValueError):
    """ADR-120: у ручного проекта нет completed_at либо started_at > completed_at."""


class PortfolioPhotosLimitError(ValueError):
    """ADR-120: больше PORTFOLIO_MAX_PHOTOS фото на проект."""


class PortfolioConsentRequiredError(ValueError):
    """domain-model.md §3.4 publish_project: FROM_CONTRACT нельзя
    публиковать без согласия второй стороны договора."""


class WorkAreaLimitError(ValueError):
    """План 11.09 §4 (ADR-182): больше WORK_AREA_MAX регионов работы на
    профиль — ограничение сервиса, не БД (докстринг `WorkArea.Meta`)."""


class WorkAreaInvalidPayloadError(ValueError):
    """Набор полей элемента не соответствует его `scope` (лишняя или
    отсутствующая ссылка, нечитаемый композитный код региона)."""


class WorkAreaUnknownLocationError(ValueError):
    """Ссылка на `apps.geo` не найдена либо неактивна (страна/регион/город
    из переимпортированного/устаревшего справочника)."""


class WorkAreaLocationMismatchError(ValueError):
    """«Внутренняя согласованность» (план 11.09 §4): город/регион не
    принадлежит указанному региону/стране того же элемента."""


class WorkAreaDuplicateError(ValueError):
    """Один и тот же объект справочника (либо `world`) указан в списке
    дважды — БД это тоже не пропустит (`work_area_unique_*`), но здесь
    ошибка read-only от валидации, до похода в БД."""


def _assert_can_edit(profile: Profile, actor: User) -> None:
    if profile.owner_user_id == actor.id:
        return
    if profile.owner_entity is not None:
        # claim'нувший управляет бизнес-профилем сразу, без бутстрапа себя
        # представителем (тот же довод, что apps.authority.services.
        # grant_representative — иначе некому было бы выдать первый
        # manage_profile).
        if profile.owner_entity.claimed_by_id == actor.id:
            return
        if authority_selectors.has_permission(
            actor, profile.owner_entity_id, Representative.Permission.MANAGE_PROFILE
        ):
            return
    raise ProfilePermissionDeniedError(
        "редактировать профиль может владелец либо представитель с manage_profile"
    )


def assert_can_edit_profile(profile: Profile, actor: User) -> None:
    """Публичная обёртка `_assert_can_edit` — нужна api/-слою там, где
    право проверяется ДО чтения, не только до записи (GET
    /profiles/{id}/work-areas: список регионов работы приватный, не
    витрина профиля — в отличие от `GET /profiles/{id}`)."""
    _assert_can_edit(profile, actor)


def create_person_profile(owner_user: Any, *, profile_public: bool) -> Profile:
    """Создаётся при регистрации (subscriber.py, топик account.logged_in,
    видимость по умолчанию — приватная: profile_public известен позже, из
    отдельного шага «Данные и приватность», docs/tasks/
    etap-3-delta-adr059.md) и обновляется при самом согласии profile_public —
    один и тот же update_or_create, идемпотентно."""
    profile, _created = Profile.objects.update_or_create(
        kind=Profile.Kind.PERSON,
        owner_user=owner_user,
        defaults={
            "profile_visibility": (
                Profile.Visibility.PUBLIC if profile_public else Profile.Visibility.LINK_AND_DEALS
            )
        },
    )
    return profile


def get_or_create_business_profile(owner_entity: Any) -> Profile:
    """Бизнес-профиль юрлица — нужен apps.contracts (Э4.1), когда сторона
    договора выступает `acting_as=business` через конкретное BusinessEntity.
    profile_visibility игнорируется на записи (business всегда PUBLIC,
    CheckConstraint `profile_business_always_public`), поэтому значение по
    умолчанию здесь — просто валидное, не смысловое. Без гейта
    `assert_entity_operable` — вызывающая сторона (apps.contracts) уже
    резолвила `entity` через собственную проверку контроля
    (`claim_status`/`claimed_by`, см. `services._resolve_own_party`), здесь
    решение не дублируется."""
    profile, _created = Profile.objects.get_or_create(
        kind=Profile.Kind.BUSINESS,
        owner_entity=owner_entity,
        defaults={"profile_visibility": Profile.Visibility.PUBLIC},
    )
    return profile


def create_business_profile(entity_id: Any) -> Profile:
    """Создаётся реактивно на `entity.claimed` (subscriber.py) — «бизнес-
    профиль по claim'нутому юрлицу» (etap-3.md 3.5). В отличие от
    `get_or_create_business_profile` заходит «с нуля» по событию, поэтому
    сама проверяет гейт `assert_entity_operable` (тот же список ADR-042,
    что и apps.authority — карточка без подтверждённого контроля профиля не
    получает) перед тем, как переиспользовать общую запись."""
    entity = BusinessEntity.objects.get(pk=entity_id)
    entities_services.assert_entity_operable(entity)
    return get_or_create_business_profile(entity)


def update_visibility(
    profile: Profile,
    *,
    profile_visibility: str | None = None,
    hide_from_catalog: bool | None = None,
    show_name: bool | None = None,
    avatar_visibility: str | None = None,
) -> Profile:
    """PATCH-подобная точка входа для полей видимости (docs/tasks/
    etap-3-delta-adr059.md §1.4). Бизнес-профиль: любая попытка задать
    profile_visibility != public — отказ ДО записи (тест 4 дельты)."""
    if (
        profile.kind == Profile.Kind.BUSINESS
        and profile_visibility is not None
        and profile_visibility != Profile.Visibility.PUBLIC
    ):
        raise ProfileVisibilityLockedError(
            "бизнес-профиль всегда публичен, пока операбелен — настройки видимости недоступны"
        )

    update_fields = []
    if profile_visibility is not None:
        profile.profile_visibility = profile_visibility
        update_fields.append("profile_visibility")
    if hide_from_catalog is not None:
        profile.hide_from_catalog = hide_from_catalog
        update_fields.append("hide_from_catalog")
    if show_name is not None:
        profile.show_name = show_name
        update_fields.append("show_name")
    if avatar_visibility is not None:
        profile.avatar_visibility = avatar_visibility
        update_fields.append("avatar_visibility")
    if update_fields:
        profile.save(update_fields=update_fields)
    return profile


def update_profile(
    profile: Profile,
    actor: User,
    *,
    city_name: str | None = None,
    works_remotely: bool | None = None,
    sphere_codes: list[str] | None = None,
    work_type_codes: list[str] | None = None,
    **visibility_fields: Any,
) -> Profile:
    """PATCH /profiles/{id} — точка входа api/-слоя: проверяет право
    редактирования (владелец либо представитель с manage_profile), затем
    делегирует поля видимости в update_visibility (гейт бизнес-профиля).
    ADR-122: `sphere_codes` — полный список (не дельта), дубли схлопываются
    с сохранением порядка, коды проверяются по каталогу.

    ADR-190 (12.09): `work_type_codes` — тоже полный список, составные коды
    `<сфера>.<категория>`. Инвариант «вид работ только внутри заявленной
    сферы» проверяется относительно ИТОГОВЫХ `sphere_codes` ЭТОГО же вызова
    (если они переданы в том же PATCH — иначе относительно уже сохранённых
    у профиля). Если `sphere_codes` сузили, а `work_type_codes` в этом же
    PATCH не передали — осиротевшие виды работ (сфера которых выпала из
    нового списка) молча обрезаются: иначе профиль остался бы в
    противоречивом состоянии до следующего явного PATCH `work_type_codes`."""
    _assert_can_edit(profile, actor)
    update_fields = []
    if city_name is not None:
        profile.city_name = city_name
        update_fields.append("city_name")
    if works_remotely is not None:
        profile.works_remotely = works_remotely
        update_fields.append("works_remotely")

    final_sphere_codes = profile.sphere_codes
    if sphere_codes is not None:
        final_sphere_codes = _normalize_sphere_codes(sphere_codes)
        profile.sphere_codes = final_sphere_codes
        update_fields.append("sphere_codes")

    if work_type_codes is not None:
        profile.work_type_codes = _normalize_work_type_codes(
            work_type_codes, allowed_sphere_codes=final_sphere_codes
        )
        update_fields.append("work_type_codes")
    elif sphere_codes is not None and profile.work_type_codes:
        pruned = [
            code for code in profile.work_type_codes if code.partition(".")[0] in final_sphere_codes
        ]
        if pruned != profile.work_type_codes:
            profile.work_type_codes = pruned
            update_fields.append("work_type_codes")

    if update_fields:
        profile.save(update_fields=update_fields)
    if any(v is not None for v in visibility_fields.values()):
        update_visibility(profile, **visibility_fields)
    profile.refresh_from_db()
    return profile


def _normalize_work_type_codes(codes: list[str], *, allowed_sphere_codes: list[str]) -> list[str]:
    """ADR-190: дубли схлопываются с сохранением порядка (тот же приём, что
    `_normalize_sphere_codes`); каждый код — `<сфера>.<категория>`, сфера
    обязана быть в `allowed_sphere_codes` (итоговые sphere_codes профиля),
    а сама пара — реальный подписанный вид работ
    (`catalog_selectors.is_selectable_work_type`)."""
    unique: list[str] = []
    for code in codes:
        normalized = (code or "").strip()
        if normalized and normalized not in unique:
            unique.append(normalized)
    if len(unique) > PROFILE_MAX_WORK_TYPES:
        raise ProfileWorkTypesLimitError(f"не больше {PROFILE_MAX_WORK_TYPES} видов работ")
    allowed = set(allowed_sphere_codes)
    for composite in unique:
        sphere_code, sep, category_code = composite.partition(".")
        if not sep or not sphere_code or not category_code:
            raise ProfileWorkTypesInvalidError(f"неверный формат вида работ: {composite!r}")
        if sphere_code not in allowed:
            raise ProfileWorkTypeSphereNotDeclaredError(
                f"сфера «{sphere_code}» не заявлена в профиле — вид работ «{composite}» недоступен"
            )
        if not catalog_selectors.is_selectable_work_type(
            sphere_code=sphere_code, code=category_code
        ):
            raise ProfileWorkTypesInvalidError(f"неизвестный вид работ: {composite}")
    return unique


def _normalize_sphere_codes(codes: list[str]) -> list[str]:
    unique: list[str] = []
    for code in codes:
        normalized = (code or "").strip()
        if normalized and normalized not in unique:
            unique.append(normalized)
    if len(unique) > PROFILE_MAX_SPHERES:
        raise ProfileSpheresLimitError(f"не больше {PROFILE_MAX_SPHERES} сфер")
    for code in unique:
        if not catalog_selectors.is_active_sphere_code(code):
            raise ProfileSpheresInvalidError(f"неизвестная сфера: {code}")
    return unique


# --- Регионы работы (план 11.09 §4, ADR-182) --------------------------------

WORK_AREA_MAX = 5

_WorkAreaKey = tuple[str, str | None, int | None, int | None]


def _resolve_work_area_item(item: dict[str, Any]) -> _WorkAreaKey:
    """Один элемент запроса → (scope, country_id, region_id, city_id),
    провалидированный и существующий в `apps.geo`. Порядок проверок —
    докстринг `replace_work_areas`."""
    scope = item.get("scope")
    if scope not in WorkArea.Scope.values:
        raise WorkAreaInvalidPayloadError(f"неизвестный масштаб: {scope!r}")

    country_raw = (item.get("country") or "").strip().upper() or None
    region_raw = (item.get("region") or "").strip() or None
    city_raw = item.get("city") or None

    if scope == WorkArea.Scope.WORLD:
        if country_raw or region_raw or city_raw:
            raise WorkAreaInvalidPayloadError("scope=world не принимает ссылку на справочник")
        return scope, None, None, None

    if scope == WorkArea.Scope.COUNTRY:
        if not country_raw or region_raw or city_raw:
            raise WorkAreaInvalidPayloadError(
                "scope=country требует country и не принимает region/city"
            )
        if not Country.objects.filter(pk=country_raw, is_active=True).exists():
            raise WorkAreaUnknownLocationError(f"страна не найдена: {country_raw}")
        return scope, country_raw, None, None

    if scope == WorkArea.Scope.REGION:
        if not region_raw or city_raw:
            raise WorkAreaInvalidPayloadError("scope=region требует region и не принимает city")
        try:
            region_country, local_code = geo_selectors.parse_region_code(region_raw)
        except geo_selectors.InvalidRegionCodeError as exc:
            raise WorkAreaInvalidPayloadError(f"код региона не разбирается: {region_raw}") from exc
        if country_raw and country_raw != region_country:
            raise WorkAreaLocationMismatchError(
                f"регион {region_raw} не принадлежит стране {country_raw}"
            )
        region = Region.objects.filter(
            country_id=region_country, code=local_code, is_active=True
        ).first()
        if region is None:
            raise WorkAreaUnknownLocationError(f"регион не найден: {region_raw}")
        return scope, None, region.id, None

    # scope == WorkArea.Scope.CITY
    if not city_raw:
        raise WorkAreaInvalidPayloadError("scope=city требует city")
    city = City.objects.filter(pk=city_raw, is_active=True).select_related("region").first()
    if city is None:
        raise WorkAreaUnknownLocationError(f"город не найден: {city_raw}")
    if region_raw:
        try:
            region_country, local_code = geo_selectors.parse_region_code(region_raw)
        except geo_selectors.InvalidRegionCodeError as exc:
            raise WorkAreaInvalidPayloadError(f"код региона не разбирается: {region_raw}") from exc
        city_region = city.region
        if (
            city_region is None
            or city.country_id != region_country
            or city_region.code != local_code
        ):
            raise WorkAreaLocationMismatchError(
                f"город {city_raw} не принадлежит региону {region_raw}"
            )
    elif country_raw and city.country_id != country_raw:
        raise WorkAreaLocationMismatchError(f"город {city_raw} не принадлежит стране {country_raw}")
    return scope, None, None, city.id


@transaction.atomic
def replace_work_areas(
    profile: Profile, actor: User, items: list[dict[str, Any]]
) -> list[WorkArea]:
    """PUT /profiles/{id}/work-areas — полная замена списка регионов
    работы, ИДЕМПОТЕНТНО по содержимому (повторный вызов с тем же списком
    даёт тот же результат, не растит число строк — id самих записей при
    этом новые, содержимое совпадает).

    Порядок валидации ОДНОГО элемента (`_resolve_work_area_item`): состав
    полей соответствует `scope` → ссылка существует и активна в `apps.geo`
    → «внутренняя согласованность» (город/регион принадлежит указанному
    региону/стране этого же элемента, план 11.09 §4). Затем — дубли ВНУТРИ
    одного запроса (`WorkAreaDuplicateError`, до похода в БД; БД поймала бы
    то же самое через `work_area_unique_*`, но так ошибка предсказуемее и
    не зависит от порядка операций внутри транзакции). Лимит
    `WORK_AREA_MAX` — до разбора элементов (незачем резолвить лишнее)."""
    _assert_can_edit(profile, actor)
    if len(items) > WORK_AREA_MAX:
        raise WorkAreaLimitError(f"не больше {WORK_AREA_MAX} регионов работы")

    resolved: list[_WorkAreaKey] = []
    seen: set[_WorkAreaKey] = set()
    for item in items:
        entry = _resolve_work_area_item(item)
        if entry in seen:
            raise WorkAreaDuplicateError(f"место указано дважды: {item!r}")
        seen.add(entry)
        resolved.append(entry)

    profile.work_areas.all().delete()
    return WorkArea.objects.bulk_create(
        [
            WorkArea(
                profile=profile,
                scope=scope,
                country_id=country_id,
                region_id=region_id,
                city_id=city_id,
            )
            for scope, country_id, region_id, city_id in resolved
        ]
    )


@dataclass(frozen=True)
class WorkAreaMigrationReport:
    """Отчёт `migrate_profile_geo_to_work_areas` (план 11.09 §4). Считает
    ОДИНАКОВО что вхолостую, что при `apply=True` — числа отражают, что
    произошло/произошло бы, независимо от режима."""

    migrated_world: int = 0
    migrated_city: int = 0
    already_migrated: int = 0
    ambiguous: list[dict[str, Any]] = field(default_factory=list)
    not_found: list[dict[str, Any]] = field(default_factory=list)


def migrate_profile_geo_to_work_areas(*, apply: bool) -> WorkAreaMigrationReport:
    """`manage.py migrate_profile_geo_to_work_areas` (план 11.09 §4, ADR-182)
    — единственный писатель, переносящий СТАРЫЕ `Profile.city_name`/
    `works_remotely` в новые `WorkArea`. НЕ data-миграция Django (докстринг
    команды — почему: на проде справочник `apps.geo` в момент прогона
    миграций схемы ещё ПУСТ, сопоставлять `city_name` не с чем; эта функция
    запускается ПОСЛЕ `import_geo`, отдельным ручным шагом).

    Правила переноса, ровно как в постановке владельца:
    - `works_remotely=True` → `WorkArea(scope=world)` (`city_name` в этом
      случае игнорируется — «весь мир» уже включает любой город);
    - иначе `city_name` ищется ТОЧНЫМ регистронезависимым совпадением по
      `apps.geo` (`geo_selectors.find_cities_by_exact_name` — имя на любом
      нашем языке, включая исторические): РОВНО одно совпадение →
      `WorkArea(scope=city)`; ноль или больше одного (одноимённые города в
      разных странах) → НЕ переносим, `city_name` остаётся текстом,
      профиль попадает в отчёт (`ambiguous`/`not_found`);
    - пустой `city_name` и `works_remotely=False` — профилю нечего
      переносить, в выборку не попадает вовсе.

    Идемпотентность: профиль, у которого уже есть хоть одна `WorkArea`
    (`work_areas__isnull=True` в выборке ниже), пропускается целиком —
    повторный прогон (в т.ч. после того, как часть профилей обработали
    руками) не плодит вторых записей и не трогает то, что уже перенесено.

    `apply=False` (умолчание команды) — ничего не пишет, только считает,
    что случилось бы; `apply=True` — пишет по одной `WorkArea` за профиль
    внутри отдельной транзакции (сбой на одном профиле не портит уже
    перенесённые соседние)."""
    eligible = Q(works_remotely=True) | ~Q(city_name="")
    already_migrated = (
        Profile.objects.filter(eligible).filter(work_areas__isnull=False).distinct().count()
    )
    candidates = (
        Profile.objects.filter(eligible).filter(work_areas__isnull=True).order_by("created_at")
    )

    migrated_world = 0
    migrated_city = 0
    ambiguous: list[dict[str, Any]] = []
    not_found: list[dict[str, Any]] = []

    for profile in candidates.iterator():
        if profile.works_remotely:
            migrated_world += 1
            if apply:
                with transaction.atomic():
                    WorkArea.objects.create(profile=profile, scope=WorkArea.Scope.WORLD)
            continue

        city_name = profile.city_name.strip()
        matches = geo_selectors.find_cities_by_exact_name(city_name)
        if len(matches) == 1:
            migrated_city += 1
            if apply:
                with transaction.atomic():
                    WorkArea.objects.create(
                        profile=profile, scope=WorkArea.Scope.CITY, city=matches[0]
                    )
        elif len(matches) > 1:
            ambiguous.append(
                {
                    "profile_id": str(profile.id),
                    "city_name": city_name,
                    "candidates": [f"{c.id}:{c.name} ({c.country_id})" for c in matches],
                }
            )
        else:
            not_found.append({"profile_id": str(profile.id), "city_name": city_name})

    return WorkAreaMigrationReport(
        migrated_world=migrated_world,
        migrated_city=migrated_city,
        already_migrated=already_migrated,
        ambiguous=ambiguous,
        not_found=not_found,
    )


@transaction.atomic
def create_portfolio_project(
    profile: Profile,
    actor: User,
    *,
    title: str,
    description: str = "",
    sphere: str,
    completed_at: Any = None,
    started_at: Any = None,
    location_label: str = "",
    media: list[Any] | None = None,
) -> PortfolioProject:
    """GET/POST /profiles/{id}/portfolio/projects — только MANUAL здесь
    (FROM_CONTRACT — сборка из договора, apps.contracts не существует,
    etap 4). ADR-120: дата завершения ОБЯЗАТЕЛЬНА («при создании нужно
    обязательно указывать даты выполнения»), город — нет."""
    _assert_can_edit(profile, actor)
    _assert_dates(started_at, completed_at)
    portfolio, _created = Portfolio.objects.get_or_create(profile=profile)
    return PortfolioProject.objects.create(
        portfolio=portfolio,
        title=title,
        description=description,
        sphere=sphere,
        started_at=started_at,
        completed_at=completed_at,
        location_label=location_label,
        media=media or [],
        source=PortfolioProject.Source.MANUAL,
    )


def _assert_dates(started_at: Any, completed_at: Any) -> None:
    if completed_at is None:
        raise PortfolioDatesInvalidError("нужна дата завершения проекта")
    if started_at is not None and started_at > completed_at:
        raise PortfolioDatesInvalidError("дата начала позже даты завершения")


def update_portfolio_project(
    project: PortfolioProject,
    actor: User,
    *,
    title: str | None = None,
    description: str | None = None,
    sphere: str | None = None,
    started_at: Any = _UNSET,
    completed_at: Any = None,
    location_label: str | None = None,
    media: list[Any] | None = None,
    order: int | None = None,
) -> PortfolioProject:
    """PATCH /portfolio/projects/{id} (ADR-120: + сфера и даты — «проекты в
    портфолио можно редактировать»). `started_at=None` явно снимает дату
    начала (_UNSET — не трогать); `completed_at` снять нельзя."""
    _assert_can_edit(project.portfolio.profile, actor)
    update_fields = []
    for field_name, value in (
        ("title", title),
        ("description", description),
        ("sphere", sphere),
        ("completed_at", completed_at),
        ("location_label", location_label),
        ("media", media),
        ("order", order),
    ):
        if value is not None:
            setattr(project, field_name, value)
            update_fields.append(field_name)
    if started_at is not _UNSET:
        project.started_at = started_at
        update_fields.append("started_at")
    if project.source == PortfolioProject.Source.MANUAL or "completed_at" in update_fields:
        _assert_dates(project.started_at, project.completed_at)
    if update_fields:
        project.save(update_fields=update_fields)
    return project


def record_from_contract_project(
    profile: Profile,
    *,
    contract_id: Any,
    title: str,
    sphere: str,
    completed_at: Any = None,
) -> PortfolioProject:
    """Единственный писатель `source=FROM_CONTRACT` (ГВ.4,
    docs/tasks/global-wave.md) — вызывается `apps.reputation.subscriber`
    на топик `contract.completed`, НЕ по HTTP (нет `actor`/permission-гейта,
    как у `create_portfolio_project`: факт завершения сделки САМ является
    правом на запись, симметрично тому, что домен уже проверил на
    предыдущих шагах, apps.contracts/apps.milestones).

    Создаётся НЕопубликованной: `publish_project` уже гейтит FROM_CONTRACT
    согласием контрагента (`counterparty_consent`, ADR-045) — сам факт
    завершения сделки такое согласие НЕ подтверждает, а фото на этом шаге
    ещё и нет (`media=[]` — реальный evidence-пайплайн с EXIF-очисткой,
    ГВ.3, вне ГВ.4). `is_verified=True` — единственный случай, когда это
    поле не False (CheckConstraint `portfolio_project_verified_only_from_contract`).

    Идемпотентно по `(portfolio, source, source_contract_id)`
    (`get_or_create`) — повторный вызов по редоставленному outbox-событию
    не плодит дубли; строгую идемпотентность самого события несёт
    `apps.reputation.models.ProcessedEvent`, эта проверка — вторая линия
    (тот же приём, что дедуп открытого спора в
    `apps.disputes.handlers.handle_milestone_rejected`)."""
    portfolio, _created = Portfolio.objects.get_or_create(profile=profile)
    sphere_value = (
        sphere if sphere in PortfolioProject.Sphere.values else PortfolioProject.Sphere.OTHER
    )
    project, _created = PortfolioProject.objects.get_or_create(
        portfolio=portfolio,
        source=PortfolioProject.Source.FROM_CONTRACT,
        source_contract_id=contract_id,
        defaults={
            "title": title or "Завершённая сделка",
            "sphere": sphere_value,
            "completed_at": completed_at,
            "is_verified": True,
            "media": [],
        },
    )
    return project


def publish_project(project: PortfolioProject, actor: User) -> PortfolioProject:
    """POST /portfolio/projects/{id}/publish (domain-model.md §3.4):
    FROM_CONTRACT требует согласия второй стороны — недостижимо сейчас
    (нет apps.contracts, нет способа создать FROM_CONTRACT-проект), но
    проверка остаётся на месте как часть инварианта модели."""
    _assert_can_edit(project.portfolio.profile, actor)
    if project.source == PortfolioProject.Source.FROM_CONTRACT and not project.counterparty_consent:
        raise PortfolioConsentRequiredError("нужно согласие второй стороны договора")
    project.is_published = True
    project.save(update_fields=["is_published"])
    return project


# --- Фото профиля (ADR-103) ---------------------------------------------------


def avatar_object_key(avatar_key: str, size: int) -> str:
    return f"{avatar_key}/{size}.webp"


def _delete_avatar_objects(avatar_key: str, store: AvatarObjectStore) -> None:
    for size in AVATAR_SIZES:
        store.delete(avatar_object_key(avatar_key, size))


def set_avatar(
    profile: Profile,
    actor: User | None,
    *,
    content: bytes,
    source: str,
    store: AvatarObjectStore | None = None,
) -> Profile:
    """POST /profiles/{id}/avatar и импорт из Google. `actor=None` — системный
    вызов (Celery-задача импорта; право там — сам факт регистрации). Исходник
    нормализуется (`images.process_avatar`: кроп, 256/64, без EXIF), старые
    объекты удаляются ПОСЛЕ успешной записи новых — при сбое посередине
    профиль остаётся со старым фото, не с битым."""
    if actor is not None:
        _assert_can_edit(profile, actor)
    if len(content) > settings.PROFILE_AVATAR_MAX_UPLOAD_BYTES:
        raise AvatarTooLargeError(f"файл больше {settings.PROFILE_AVATAR_MAX_UPLOAD_BYTES} байт")
    variants = process_avatar(content)
    store = store or build_avatar_store()

    new_key = f"avatars/{profile.id}/{uuid7()}"
    for size, body in variants.items():
        store.put(avatar_object_key(new_key, size), body, content_type=AVATAR_CONTENT_TYPE)

    old_key = profile.avatar_key
    profile.avatar_key = new_key
    profile.avatar_source = source
    profile.avatar_updated_at = timezone.now()
    profile.save(update_fields=["avatar_key", "avatar_source", "avatar_updated_at"])
    if old_key:
        _delete_avatar_objects(old_key, store)
    return profile


def remove_avatar(
    profile: Profile, actor: User, *, store: AvatarObjectStore | None = None
) -> Profile:
    """DELETE /profiles/{id}/avatar — идемпотентно. Объекты удаляются
    физически (ПД), Google-фото после этого не возвращается: импорт
    бывает только при регистрации (subscriber.py)."""
    _assert_can_edit(profile, actor)
    if not profile.avatar_key:
        return profile
    store = store or build_avatar_store()
    old_key = profile.avatar_key
    profile.avatar_key = ""
    profile.avatar_source = Profile.AvatarSource.NONE
    profile.avatar_updated_at = timezone.now()
    profile.save(update_fields=["avatar_key", "avatar_source", "avatar_updated_at"])
    _delete_avatar_objects(old_key, store)
    return profile


AvatarFetcher = Callable[[str], bytes | None]


def fetch_https_image(url: str) -> bytes | None:
    """Скачивание стартового фото из Google: только https, лимит байт —
    тот же, что у загрузки, таймаут — настройка. Любая ошибка → None
    (фото не критично, ретраев нет — ADR-103 п.2)."""
    import httpx

    if not url.startswith("https://"):
        return None
    limit = settings.PROFILE_AVATAR_MAX_UPLOAD_BYTES
    try:
        with (
            httpx.Client(
                timeout=settings.PROFILE_AVATAR_FETCH_TIMEOUT_SECONDS, follow_redirects=True
            ) as client,
            client.stream("GET", url) as response,
        ):
            response.raise_for_status()
            chunks: list[bytes] = []
            total = 0
            for chunk in response.iter_bytes():
                total += len(chunk)
                if total > limit:
                    return None
                chunks.append(chunk)
        return b"".join(chunks)
    except httpx.HTTPError:
        return None


def import_external_avatar(
    profile: Profile,
    url: str,
    *,
    fetcher: AvatarFetcher | None = None,
    store: AvatarObjectStore | None = None,
) -> bool:
    """Стартовое фото из Google (ADR-103 п.2): только если фото ещё нет —
    загруженное/удалённое пользователем не перетирается. True — фото
    установлено."""
    if profile.avatar_key:
        return False
    content = (fetcher or fetch_https_image)(url)
    if not content:
        return False
    try:
        set_avatar(profile, None, content=content, source=Profile.AvatarSource.GOOGLE, store=store)
    except (InvalidAvatarImageError, AvatarTooLargeError):
        logger.info("profiles.avatar.import_skipped", extra={"profile_id": str(profile.id)})
        return False
    return True


# --- Портфолио: фото проекта (ADR-115 обложка → ADR-120 галерея до 5) ------

PORTFOLIO_MAX_PHOTOS = 5


def portfolio_object_key(image_key: str, size: int) -> str:
    return f"{image_key}/{size}.webp"


def _store_variants(profile: Profile, content: bytes, store: AvatarObjectStore) -> str:
    """Санитария — images.process_portfolio_image (EXIF прочь, WebP 1280/320,
    аспект сохраняется); возвращает новый ключ."""
    if len(content) > settings.PROFILE_PORTFOLIO_MAX_UPLOAD_BYTES:
        raise AvatarTooLargeError(f"файл больше {settings.PROFILE_PORTFOLIO_MAX_UPLOAD_BYTES} байт")
    variants = process_portfolio_image(content)
    new_key = f"portfolio/{profile.id}/{uuid7()}"
    for size, body in variants.items():
        store.put(portfolio_object_key(new_key, size), body, content_type=AVATAR_CONTENT_TYPE)
    return new_key


def _delete_variants(key: str, store: AvatarObjectStore) -> None:
    for size in PORTFOLIO_SIZES:
        store.delete(portfolio_object_key(key, size))


def _sync_cover(project: PortfolioProject) -> None:
    """`photo_key` — зеркало основного фото (photos[0]): пересчёт порядка без
    дыр + запись ключа обложки, чтобы `GET .../photo` и старые бандлы жили."""
    photos = list(project.photos.order_by("order", "created_at"))
    for index, photo in enumerate(photos):
        if photo.order != index:
            photo.order = index
            photo.save(update_fields=["order"])
    cover = photos[0].photo_key if photos else ""
    if project.photo_key != cover:
        project.photo_key = cover
        project.save(update_fields=["photo_key"])


@transaction.atomic
def add_project_photo(
    profile: Profile,
    actor: User,
    project: PortfolioProject,
    *,
    content: bytes,
    store: AvatarObjectStore | None = None,
) -> PortfolioPhoto:
    """POST /portfolio/projects/{id}/photos — добавить фото в конец галереи
    (ADR-120); первое добавленное становится основным. Больше
    PORTFOLIO_MAX_PHOTOS — PortfolioPhotosLimitError (409)."""
    _assert_can_edit(profile, actor)
    if project.photos.count() >= PORTFOLIO_MAX_PHOTOS:
        raise PortfolioPhotosLimitError(f"не больше {PORTFOLIO_MAX_PHOTOS} фото на проект")
    store = store or build_avatar_store()
    new_key = _store_variants(profile, content, store)
    photo = PortfolioPhoto.objects.create(
        project=project, photo_key=new_key, order=project.photos.count()
    )
    _sync_cover(project)
    return photo


@transaction.atomic
def remove_project_photo_item(
    profile: Profile,
    actor: User,
    project: PortfolioProject,
    photo: PortfolioPhoto,
    *,
    store: AvatarObjectStore | None = None,
) -> PortfolioProject:
    """DELETE /portfolio/projects/{id}/photos/{photo_id} — объекты удаляются
    физически, следующее фото становится основным."""
    _assert_can_edit(profile, actor)
    key = photo.photo_key
    photo.delete()
    _sync_cover(project)
    _delete_variants(key, store or build_avatar_store())
    return project


@transaction.atomic
def set_primary_project_photo(
    profile: Profile, actor: User, project: PortfolioProject, photo: PortfolioPhoto
) -> PortfolioProject:
    """POST /portfolio/projects/{id}/photos/{photo_id}/primary — сделать
    основным (первым); остальные сдвигаются, порядок сохраняется."""
    _assert_can_edit(profile, actor)
    others = project.photos.exclude(pk=photo.pk).order_by("order", "created_at")
    photo.order = 0
    photo.save(update_fields=["order"])
    for index, other in enumerate(others, start=1):
        other.order = index
        other.save(update_fields=["order"])
    _sync_cover(project)
    return project


@transaction.atomic
def set_project_photo(
    profile: Profile,
    actor: User,
    project: PortfolioProject,
    *,
    content: bytes,
    store: AvatarObjectStore | None = None,
) -> PortfolioProject:
    """POST /portfolio/projects/{id}/photo (ADR-115, совместимость): заменить
    ОСНОВНОЕ фото (или добавить первое). Старые объекты удаляются ПОСЛЕ
    записи новых (как set_avatar)."""
    _assert_can_edit(profile, actor)
    store = store or build_avatar_store()
    primary = project.photos.order_by("order", "created_at").first()
    new_key = _store_variants(profile, content, store)
    if primary is None:
        PortfolioPhoto.objects.create(project=project, photo_key=new_key, order=0)
    else:
        old_key = primary.photo_key
        primary.photo_key = new_key
        primary.save(update_fields=["photo_key"])
        _delete_variants(old_key, store)
    _sync_cover(project)
    return project


@transaction.atomic
def remove_project_photo(
    profile: Profile,
    actor: User,
    project: PortfolioProject,
    *,
    store: AvatarObjectStore | None = None,
) -> PortfolioProject:
    """DELETE .../photo (ADR-115, совместимость) — убрать основное фото;
    идемпотентно."""
    _assert_can_edit(profile, actor)
    primary = project.photos.order_by("order", "created_at").first()
    if primary is None:
        if project.photo_key:
            # Легаси-строка без PortfolioPhoto (до миграции 0007 не дошла) — чистим ключ.
            _delete_variants(project.photo_key, store or build_avatar_store())
            project.photo_key = ""
            project.save(update_fields=["photo_key"])
        return project
    return remove_project_photo_item(profile, actor, project, primary, store=store)


# --- Удаление аккаунта (ADR-169) -----------------------------------------


@transaction.atomic
def purge_personal_data(user_id: Any, *, store: AvatarObjectStore | None = None) -> None:  # noqa: ANN401
    """Уничтожение ПД личных профилей при удалении аккаунта (DELETE
    /users/me, ADR-169). Системный вызов: `actor` нет и быть не может —
    `_assert_can_edit` здесь не при чём (право даёт сам факт удаления
    СВОЕГО аккаунта, проверенный в apps.accounts), а звать `remove_avatar`
    от имени удаляемого пользователя значило бы имитировать его действие.

    Сама строка `Profile` НЕ удаляется: `ContractParty.profile` и
    `Message.sender_profile` — PROTECT, профиль стороны договора держит
    доказательную базу чужой сделки. Уничтожается СОДЕРЖИМОЕ: байты фото в
    S3 (мягкого удаления ПД нет — CLAUDE.md), проекты портфолио целиком
    (свободные тексты, места, даты), город, заявленные сферы и виды работ
    (ADR-190). Имя расшифровке уже не подлежит — ключ субъекта уничтожен в
    apps.accounts.

    Бизнес-профили (`owner_entity`) не трогаются: они принадлежат ЮРЛИЦУ,
    а не человеку, и переживают уход конкретного представителя.

    Идемпотентно: повторный вызов не находит ни ключей, ни проектов.
    """
    profiles = list(Profile.objects.filter(owner_user_id=user_id))
    if not profiles:
        return
    store = store or build_avatar_store()
    for profile in profiles:
        for photo in PortfolioPhoto.objects.filter(project__portfolio__profile=profile):
            _delete_variants(photo.photo_key, store)
        for project in PortfolioProject.objects.filter(portfolio__profile=profile):
            if project.photo_key:
                # Легаси-обложка без строки PortfolioPhoto (см. remove_project_photo).
                _delete_variants(project.photo_key, store)
        PortfolioProject.objects.filter(portfolio__profile=profile).delete()
        old_avatar_key = profile.avatar_key
        profile.avatar_key = ""
        profile.avatar_source = Profile.AvatarSource.NONE
        profile.avatar_updated_at = timezone.now()
        profile.city_name = ""
        profile.works_remotely = False
        profile.sphere_codes = []
        profile.work_type_codes = []  # ADR-190: тот же crypto-shredding, что sphere_codes
        # Витрины: удалённого не должно быть ни в каталоге, ни в поиске.
        profile.hide_from_catalog = True
        profile.show_name = False
        profile.save(
            update_fields=[
                "avatar_key",
                "avatar_source",
                "avatar_updated_at",
                "city_name",
                "works_remotely",
                "sphere_codes",
                "work_type_codes",
                "hide_from_catalog",
                "show_name",
            ]
        )
        if old_avatar_key:
            _delete_avatar_objects(old_avatar_key, store)
