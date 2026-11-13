"""Внутренние read-only эндпоинты метрик — docs/tasks/marketing-metrics.md §9.1.

Вьюхи тонкие (CLAUDE.md §2.4): разбор параметров и вызов селектора, вся
логика — в `selectors.py`. Ответ — плоский JSON той же формы, что отдаёт
SQL-мост `analytics/*` (§9.3), чтобы перевод клиента на API менял только
`analytics/client.py`.

Схема в публичный OpenAPI не выводится (`exclude=True`): эндпоинты
внутренние, их незачем показывать в Swagger рядом с продуктовым API.
"""

from __future__ import annotations

from typing import Any

from drf_spectacular.utils import extend_schema
from rest_framework import status
from rest_framework.exceptions import Throttled
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.views import APIView
from rest_framework_simplejwt.authentication import JWTAuthentication

from common.net import client_ip

from .. import selectors, services
from .permissions import InternalMetricsPermission
from .serializers import ConstructorStepSerializer, InstallEventSerializer

_MAX_DAYS = 400
_MAX_WEEKS = 104


def _int_param(
    request: Request, name: str, default: int, maximum: int, *, alias: str | None = None
) -> int:
    """Алиас нужен потому, что клиент моста (`analytics/client.py`) шлёт имя
    параметра из SQL-файла (`window_days`), а эндпоинты исторически читают
    короткое `window`. Без алиаса окно молча подменялось бы значением по
    умолчанию, и сверка sql/api показывала бы расхождение на ровном месте."""
    raw = request.query_params.get(name)
    if raw is None and alias is not None:
        raw = request.query_params.get(alias)
    if raw is None:
        return default
    try:
        value = int(raw)
    except (TypeError, ValueError):
        return default
    return max(1, min(value, maximum))


class InternalMetricsView(APIView):
    """Общий предок: аутентификации нет — есть статический токен и адрес."""

    authentication_classes: list[Any] = []
    permission_classes = [InternalMetricsPermission]


@extend_schema(exclude=True)
class PulseView(InternalMetricsView):
    """GET /internal/v1/metrics/pulse?days=30 — ежедневный монитор (§10),
    массив по дням."""

    def get(self, request: Request) -> Response:
        days = _int_param(request, "days", 30, _MAX_DAYS)
        return Response(selectors.pulse(days=days))


@extend_schema(exclude=True)
class GeographyView(InternalMetricsView):
    """GET /internal/v1/metrics/geography?window=30 — страны: регистрации,
    живые договоры, воронка, доля кросс-страновых, динамика по дням (§4)."""

    def get(self, request: Request) -> Response:
        window = _int_param(request, "window", 30, _MAX_DAYS, alias="window_days")
        return Response(selectors.geography(window_days=window))


@extend_schema(exclude=True)
class AcquisitionView(InternalMetricsView):
    """GET /internal/v1/metrics/acquisition?window=90 — приток, источники,
    K-фактор и время жизни приглашения (§5.1, §5.3)."""

    def get(self, request: Request) -> Response:
        window = _int_param(request, "window", 90, _MAX_DAYS, alias="window_days")
        return Response(selectors.acquisition(window_days=window))


@extend_schema(exclude=True)
class FunnelView(InternalMetricsView):
    """GET /internal/v1/metrics/funnel?window=90 — воронка от регистрации до
    первого принятого этапа с отвалами по шагам (§5.2) и глубина сделки (§6)."""

    def get(self, request: Request) -> Response:
        window = _int_param(request, "window", 90, _MAX_DAYS, alias="window_days")
        return Response(selectors.funnel(window_days=window))


@extend_schema(exclude=True)
class LanguagesView(InternalMetricsView):
    """GET /internal/v1/metrics/languages — распределение по языкам
    интерфейса, вход для приоритета вычитки (§4.2)."""

    def get(self, request: Request) -> Response:
        window = _int_param(request, "window", 30, _MAX_DAYS, alias="window_days")
        return Response(selectors.languages(window_days=window))


@extend_schema(exclude=True)
class CohortsView(InternalMetricsView):
    """GET /internal/v1/metrics/cohorts?weeks=12 — когорты по неделям
    регистрации и удержание (§5.4)."""

    def get(self, request: Request) -> Response:
        weeks = _int_param(request, "weeks", 12, _MAX_WEEKS)
        return Response(selectors.cohorts(weeks=weeks))


@extend_schema(exclude=True)
class HealthView(InternalMetricsView):
    """GET /internal/v1/metrics/health?days=7 — доставляемость, кворум меток,
    целостность цепочки, отставание свипа, свежесть витрин (§7)."""

    def get(self, request: Request) -> Response:
        days = _int_param(request, "days", 7, _MAX_DAYS)
        return Response(selectors.health(days=days))


@extend_schema(exclude=True)
class InstallsView(InternalMetricsView):
    """GET /internal/v1/metrics/installs?window=90 — воронка установки
    приложения: показали предложение → нажали → поставили, плюс разрезы по
    платформам и источникам (ADR-171).

    Тот же блок едет внутри `acquisition` (установка — канал привлечения), но
    своей ручкой он попадает в снимок `analytics/snapshots/` отдельным файлом
    и сверяется с мостом `analytics/sql/installs.sql`."""

    def get(self, request: Request) -> Response:
        window = _int_param(request, "window", 90, _MAX_DAYS, alias="window_days")
        return Response(selectors.installs_metric(window_days=window))


@extend_schema(exclude=True)
class SearchFiltersView(InternalMetricsView):
    """GET /internal/v1/metrics/search-filters?window=90 — каталожный поиск
    исполнителей (ADR-184): сколько поисков всего, сколько с хотя бы одним
    фильтром, разрез по видам фильтра и их сочетаниям (ADR-186)."""

    def get(self, request: Request) -> Response:
        window = _int_param(request, "window", 90, _MAX_DAYS, alias="window_days")
        return Response(selectors.search_filters_metric(window_days=window))


@extend_schema(exclude=True)
class ConstructorStepView(APIView):
    """POST /v1/analytics/constructor-step — единственный поведенческий слой
    продукта (§8.1): шаги конструктора договора.

    Заведён потому, что брошенный черновик иначе неизмерим: доменного события
    «бросил на шаге 3» не существует и не должно существовать. В теле —
    только код шага, действие и идентификатор черновика; ни пользователя, ни
    IP, ни содержимого полей формы тут нет и не появится.

    Требует аутентификации — и это не про персональные данные, а про
    защиту от мусора: анонимная запись без лимита позволила бы кому угодно
    залить витрину выдуманными шагами. Мастер договора и так живёт за
    логином, так что для продукта ограничение бесплатное. Личность
    аутентифицированного пользователя в событие НЕ ПОПАДАЕТ — она нужна
    только на входе, чтобы отсечь чужих."""

    permission_classes = [IsAuthenticated]

    def post(self, request: Request) -> Response:
        serializer = ConstructorStepSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        services.record_constructor_step(**serializer.validated_data)
        return Response(status=status.HTTP_204_NO_CONTENT)


@extend_schema(exclude=True)
class InstallEventView(APIView):
    """POST /v1/analytics/install-event — воронка установки приложения
    (ADR-171): показ предложения, нажатие, установка, переход в Google Play,
    открытие в режиме приложения.

    В отличие от событий конструктора, вход АНОНИМНЫЙ. Это не послабление, а
    условие измеримости: приложение ставят с посадочной страницы, до входа —
    требование логина отсекло бы ровно тот случай, ради которого счётчик и
    заведён. Взамен ручку защищает лимит по адресу (`services`), а набор
    видов событий закрыт перечислением: залить сюда произвольную телеметрию
    нельзя.

    Личность попадает в событие ТОЛЬКО из токена и только когда токен есть.
    Из тела `user_id` не принимается: иначе установку можно было бы приписать
    чужому аккаунту."""

    authentication_classes = [JWTAuthentication]
    permission_classes = [AllowAny]

    def post(self, request: Request) -> Response:
        try:
            services.check_install_event_rate_limit(client_ip(request))
        except services.InstallEventRateLimitedError:
            raise Throttled(detail="слишком много событий установки с этого адреса") from None
        serializer = InstallEventSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        user = getattr(request, "user", None)
        user_id = getattr(user, "id", None) if getattr(user, "is_authenticated", False) else None
        services.record_install_event(user_id=user_id, **serializer.validated_data)
        return Response(status=status.HTTP_204_NO_CONTENT)
