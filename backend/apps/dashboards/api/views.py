from __future__ import annotations

from typing import Any, cast

from drf_spectacular.utils import OpenApiParameter, extend_schema
from rest_framework.exceptions import ValidationError
from rest_framework.permissions import IsAuthenticated
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.accounts.models import User
from apps.geo.selectors import InvalidRegionCodeError
from common.i18n import resolve_request_locale

from .. import selectors, services
from .serializers import (
    DashboardSerializer,
    PaymentsSerializer,
    SearchSerializer,
    StagesSerializer,
)

# --- GET /dashboard/search — параметры каталожного фильтра (план 11.09 §5, --
# ADR-184) ------------------------------------------------------------------
#
# Присутствие ЛЮБОГО из них (либо явного `catalog=1` — «весь мир, без
# фильтра») включает вычисление ветки `catalog` ответа; без них она
# приходит пустой (`items: []`), а `q`/`zone` работают как раньше.
_CATALOG_FLAG_PARAMS = (
    "catalog",
    "country",
    "region",
    "city",
    "experience_min",
    "has_experience",
    "cursor",
)


def _catalog_requested(request: Request) -> bool:
    params = request.query_params
    if params.getlist("sphere") or params.getlist("work_type"):
        return True
    return any((params.get(name) or "").strip() for name in _CATALOG_FLAG_PARAMS)


def _geo_filter_params(request: Request) -> tuple[str | None, str | None, int | None]:
    """Формат — здесь (400 на нечитаемое); существование ссылки на
    `apps.geo` — НЕ здесь (несуществующий код/id даёт пустую выдачу, не
    ошибку, см. `apps.profiles.selectors.geo_filter_coverage_q`)."""
    country_raw = (request.query_params.get("country") or "").strip()
    country = None
    if country_raw:
        country = country_raw.upper()
        if len(country) != 2 or not country.isalpha():
            raise ValidationError({"country": "код ISO 3166-1 alpha-2, например KZ"})
    region = (request.query_params.get("region") or "").strip() or None
    city_raw = request.query_params.get("city")
    city = None
    if city_raw:
        try:
            city = int(city_raw)
        except (TypeError, ValueError):
            raise ValidationError({"city": "id города из /v1/geo/cities"}) from None
    return country, region, city


def _experience_param(request: Request) -> int | None:
    """`experience_min` (порог числа завершённых сделок) и/или
    `has_experience` (эквивалент «минимум 1») — комбинация берёт больший
    порог из двух."""
    raw_min = request.query_params.get("experience_min")
    min_experience: int | None = None
    if raw_min is not None:
        try:
            min_experience = int(raw_min)
        except (TypeError, ValueError):
            raise ValidationError({"experience_min": "целое число"}) from None
        if min_experience < 0:
            raise ValidationError({"experience_min": "0 или больше"})
    has_flag = (request.query_params.get("has_experience") or "").strip().lower()
    if has_flag in ("1", "true", "yes"):
        min_experience = max(min_experience or 0, 1)
    return min_experience


def _metric_geo_level(country: str | None, region: str | None, city: int | None) -> str:
    """Уровень гео-фильтра для метрики поиска (ADR-186) — тот же принцип
    «побеждает самый глубокий», что и в самом покрытии (ADR-184): считаем не
    сырое присутствие параметра, а фактически применённый уровень."""
    if city:
        return "city"
    if region:
        return "region"
    if country:
        return "country"
    return "none"


def _catalog_limit_param(request: Request) -> int:
    raw = request.query_params.get("limit")
    if raw is None:
        return selectors.CATALOG_PAGE_SIZE_DEFAULT
    try:
        limit = int(raw)
    except (TypeError, ValueError):
        raise ValidationError({"limit": "целое число"}) from None
    if not 1 <= limit <= selectors.CATALOG_PAGE_SIZE_MAX:
        raise ValidationError({"limit": f"от 1 до {selectors.CATALOG_PAGE_SIZE_MAX}"})
    return limit


_CATALOG_PARAMS = [
    OpenApiParameter(
        "country",
        str,
        required=False,
        description="ISO 3166-1 alpha-2 — покрывает регионы/города внутри",
    ),
    OpenApiParameter(
        "region",
        str,
        required=False,
        description="Составной код из /v1/geo/regions, например KZ-02",
    ),
    OpenApiParameter("city", int, required=False, description="id города из /v1/geo/cities"),
    OpenApiParameter(
        "sphere",
        str,
        required=False,
        description="Код сферы каталога, повторяемый параметр — ИЛИ между значениями",
    ),
    OpenApiParameter(
        "work_type",
        str,
        required=False,
        description=(
            "Составной код вида работ `<сфера>.<категория>` (ADR-190), повторяемый — ИЛИ "
            "между значениями; с прочими фильтрами — И"
        ),
    ),
    OpenApiParameter(
        "experience_min", int, required=False, description="Минимум завершённых сделок исполнителем"
    ),
    OpenApiParameter(
        "has_experience", bool, required=False, description="Эквивалент experience_min=1"
    ),
    OpenApiParameter(
        "catalog",
        bool,
        required=False,
        description="Включить выдачу catalog без прочих фильтров («весь мир»)",
    ),
    OpenApiParameter(
        "limit",
        int,
        required=False,
        description=(
            f"Страница catalog: по умолчанию {selectors.CATALOG_PAGE_SIZE_DEFAULT}, "
            f"максимум {selectors.CATALOG_PAGE_SIZE_MAX}"
        ),
    ),
    OpenApiParameter(
        "cursor", str, required=False, description="catalog.next_cursor предыдущей страницы"
    ),
]


class DashboardView(APIView):
    """GET /dashboard (ADR-090) — главный экран после входа: «что требует
    моего действия» (подпись/приёмка/сдача этапа), read-only, по ВСЕМ моим
    сделкам разом. «Мои сделки» на экране — отдельный, уже реальный
    `GET /v1/contracts` (ADR-090 §1) — не дублируется здесь. Без параметров:
    `role`/`period` из старого мок-контракта убраны целиком, не просто
    проигнорированы — фильтровать/масштабировать в этом ответе больше
    нечего (ADR-090 §4)."""

    permission_classes = [IsAuthenticated]

    @extend_schema(responses={200: DashboardSerializer})
    def get(self, request: Request) -> Response:
        data = selectors.get_dashboard(cast(User, request.user))
        return Response(DashboardSerializer(data).data)


class StagesView(APIView):
    """GET /dashboard/stages — раздел «Этапы» (отсмотр 2026-08-22): сводка
    листьев по всем моим договорам в исполнении. Read-only агрегат поверх
    чужих selectors — по месту жительства кросс-договорных срезов (ADR-090)."""

    permission_classes = [IsAuthenticated]

    @extend_schema(responses={200: StagesSerializer})
    def get(self, request: Request) -> Response:
        data = selectors.get_stages(cast(User, request.user), request)
        return Response(StagesSerializer(data).data)


class PaymentsView(APIView):
    """GET /dashboard/payments — раздел «Платежи» (отсмотр 2026-08-22):
    денежные листья с платёжным состоянием из двусторонних подтверждений
    (tech-spec.md §6.3; платёжного контура нет — финмодель v2)."""

    permission_classes = [IsAuthenticated]

    @extend_schema(responses={200: PaymentsSerializer})
    def get(self, request: Request) -> Response:
        data = selectors.get_payments(cast(User, request.user), request)
        return Response(PaymentsSerializer(data).data)


class SearchView(APIView):
    """GET /dashboard/search?q=&zone=&country=&region=&city=&sphere=&
    work_type=&experience_min=&has_experience=&limit=&cursor= — ДВЕ
    независимые ветки одного ответа: `profiles`/`groups`/`spheres`
    (ADR-114, отсмотр 2026-08-23) — адресная находимость по
    @хендлу/телефону/тексту сферы с гео-зонами world|country|city, работает
    как раньше; `catalog` (план 11.09 §5, ADR-184; виды работ — ADR-190,
    12.09) — каталожный фильтр исполнителей (гео на любом уровне через
    WorkArea, сферы каталога, виды работ каталога, порог опыта),
    keyset-пагинация. `catalog` считается, только если запрошен (см.
    `_catalog_requested`) — иначе приходит пустым, вторая ветка не платит
    за него запросами."""

    permission_classes = [IsAuthenticated]

    @extend_schema(parameters=_CATALOG_PARAMS, responses={200: SearchSerializer})
    def get(self, request: Request) -> Response:
        query = (request.query_params.get("q") or "").strip()
        zone = request.query_params.get("zone")
        data: dict[str, Any]
        if len(query) < 2:
            data = {
                "applied_zone": zone if zone in selectors.SEARCH_ZONES else "world",
                "profiles": [],
                "groups": [],
                "spheres": [],
            }
        else:
            data = selectors.get_search(
                cast(User, request.user),
                query=query,
                zone=zone,
                locale=resolve_request_locale(request),
            )

        if _catalog_requested(request):
            country, region, city = _geo_filter_params(request)
            sphere_codes = [c.strip() for c in request.query_params.getlist("sphere") if c.strip()]
            work_type_codes = [
                c.strip() for c in request.query_params.getlist("work_type") if c.strip()
            ]
            min_experience = _experience_param(request)
            cursor = request.query_params.get("cursor") or None
            try:
                data["catalog"] = selectors.get_search_catalog(
                    viewer=cast(User, request.user),
                    country=country,
                    region=region,
                    city=city,
                    sphere_codes=sphere_codes,
                    work_type_codes=work_type_codes,
                    min_experience=min_experience,
                    limit=_catalog_limit_param(request),
                    cursor=cursor,
                    locale=resolve_request_locale(request),
                    request=request,
                )
            except InvalidRegionCodeError:
                raise ValidationError(
                    {"region": "код региона из /v1/geo/regions, например KZ-02"}
                ) from None
            except selectors.InvalidCatalogCursorError:
                raise ValidationError({"cursor": "курсор не разбирается"}) from None
            # Метрика «поисков с фильтром» (ADR-186) — только ПЕРВАЯ страница
            # поиска: перелистывание тех же результатов (запрос с cursor) не
            # новый поиск, а продолжение уже случившегося, и не должно
            # накручивать счётчик.
            if cursor is None:
                services.record_catalog_search_metric(
                    user_id=cast(User, request.user).id,
                    geo_level=_metric_geo_level(country, region, city),
                    has_sphere=bool(sphere_codes),
                    has_experience=min_experience is not None,
                )
        else:
            data["catalog"] = {"items": [], "next_cursor": None}

        return Response(SearchSerializer(data, context={"request": request}).data)
