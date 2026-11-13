"""api/ apps.geo — тонкие вьюхи над selectors.py (план 11.09 §4). Доступ —
только авторизованные (данные не приватные, но и не публичный анонимный
эндпоинт: справочник существует для фильтра поиска исполнителей внутри
продукта).

`display_name` в ответе (`api/serializers.py::_display_name`, план 11.09
§2b, ADR-181) — название НА ЯЗЫКЕ ЗРИТЕЛЯ, поэтому сериализаторам передаётся
`context={"request": request}` (иначе `_display_name` фолбэкнулся бы на
`DEFAULT_LOCALE` для всех, теряя смысл поля)."""

from __future__ import annotations

from drf_spectacular.utils import OpenApiParameter, extend_schema
from rest_framework.exceptions import ValidationError
from rest_framework.permissions import IsAuthenticated
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.views import APIView

from .. import selectors
from .serializers import CityPageSerializer, CountrySerializer, RegionSerializer


def _country_param(request: Request) -> str | None:
    raw = request.query_params.get("country")
    if not raw:
        return None
    code = raw.strip().upper()
    if len(code) != 2 or not code.isalpha():
        raise ValidationError({"country": "код ISO 3166-1 alpha-2, например KZ"})
    return code


def _limit_param(request: Request, *, default: int, maximum: int) -> int:
    raw = request.query_params.get("limit")
    if raw is None:
        return default
    try:
        limit = int(raw)
    except (TypeError, ValueError):
        raise ValidationError({"limit": "целое число"}) from None
    if not 1 <= limit <= maximum:
        raise ValidationError({"limit": f"от 1 до {maximum}"})
    return limit


class CountryListView(APIView):
    """GET /v1/geo/countries — активные страны справочника (только коды,
    названия локализует фронт — apps.geo.models.Country)."""

    permission_classes = [IsAuthenticated]

    @extend_schema(responses={200: CountrySerializer(many=True)})
    def get(self, request: Request) -> Response:
        countries = selectors.list_countries()
        return Response(CountrySerializer(countries, many=True).data)


class RegionListView(APIView):
    """GET /v1/geo/regions?country=&q=&limit= — регионы, префиксный поиск."""

    permission_classes = [IsAuthenticated]

    @extend_schema(
        parameters=[
            OpenApiParameter("country", str, required=False, description="ISO 3166-1 alpha-2"),
            OpenApiParameter(
                "q", str, required=False, description="Префикс названия (любой язык/латиница)"
            ),
            OpenApiParameter(
                "limit",
                int,
                required=False,
                description=(
                    f"По умолчанию {selectors.REGION_LIMIT_DEFAULT}, "
                    f"максимум {selectors.REGION_LIMIT_MAX}"
                ),
            ),
        ],
        responses={200: RegionSerializer(many=True)},
    )
    def get(self, request: Request) -> Response:
        country = _country_param(request)
        limit = _limit_param(
            request, default=selectors.REGION_LIMIT_DEFAULT, maximum=selectors.REGION_LIMIT_MAX
        )
        regions = selectors.search_regions(
            country=country, q=request.query_params.get("q"), limit=limit
        )
        return Response(RegionSerializer(regions, many=True, context={"request": request}).data)


class CityListView(APIView):
    """GET /v1/geo/cities?country=&region=&q=&limit=&cursor= — города,
    сначала крупные, keyset-пагинация."""

    permission_classes = [IsAuthenticated]

    @extend_schema(
        parameters=[
            OpenApiParameter("country", str, required=False, description="ISO 3166-1 alpha-2"),
            OpenApiParameter(
                "region",
                str,
                required=False,
                description="Составной код региона из /v1/geo/regions, например KZ-02",
            ),
            OpenApiParameter(
                "q", str, required=False, description="Префикс названия (любой язык/латиница)"
            ),
            OpenApiParameter(
                "limit",
                int,
                required=False,
                description=(
                    f"По умолчанию {selectors.CITY_LIMIT_DEFAULT}, "
                    f"максимум {selectors.CITY_LIMIT_MAX}"
                ),
            ),
            OpenApiParameter(
                "cursor", str, required=False, description="next_cursor предыдущей страницы"
            ),
        ],
        responses={200: CityPageSerializer},
    )
    def get(self, request: Request) -> Response:
        country = _country_param(request)
        region = request.query_params.get("region") or None
        limit = _limit_param(
            request, default=selectors.CITY_LIMIT_DEFAULT, maximum=selectors.CITY_LIMIT_MAX
        )
        try:
            if region:
                selectors.parse_region_code(region)
        except selectors.InvalidRegionCodeError:
            raise ValidationError(
                {"region": "код региона из /v1/geo/regions, например KZ-02"}
            ) from None

        try:
            page = selectors.list_cities(
                country=country,
                region=region,
                q=request.query_params.get("q"),
                limit=limit,
                cursor=request.query_params.get("cursor") or None,
            )
        except selectors.InvalidCityCursorError:
            raise ValidationError({"cursor": "курсор не разбирается"}) from None

        return Response(CityPageSerializer(page, context={"request": request}).data)
