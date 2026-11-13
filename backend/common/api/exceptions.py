"""DRF exception handler → application/problem+json (tech-spec.md §7.5).

DomainAPIError — то, что api/-слой поднимает в ответ на исключения из
services.py (сервисы бросают обычные ValueError-наследники, ни о каком HTTP
не знают; перевод в статус/код — работа view, CLAUDE.md: "api/ (тонкие
DRF-вьюхи) → services.py"). Прочие исключения DRF (ValidationError,
NotAuthenticated, PermissionDenied, NotFound, Throttled, ...) переупаковываются
в ту же форму с обобщённым code по HTTP-статусу.

`title` — на языке запроса для не-RU контура (ГВ.5, docs/tasks/
global-wave.md, ADR-075; расширено Л.2, docs/tasks/l10n-wave.md, ADR-077):
common.i18n.resolve_request_locale(request) — контур пользователя
приоритетно, Accept-Language как подсказка для анонимных запросов.
Приоритет источника title: apps.l10n.selectors.get_error_title (пакет
языка, Л.2, с собственным фолбэком locale→en) → error_texts.ERROR_TITLES_EN
(встроенный EN-реестр по `code`, не по конкретному вызову, см. его
докстринг) → исходный (RU) title вызова. `detail` НЕ переводится
(динамический RU-текст из services.py). `code` не локализуется никогда
(common/api/problem.py)."""

from __future__ import annotations

from typing import Any

from rest_framework.exceptions import APIException
from rest_framework.renderers import JSONRenderer
from rest_framework.response import Response
from rest_framework.views import exception_handler

from apps.l10n.selectors import get_error_title
from common.i18n import resolve_request_locale

from .error_texts import ERROR_TITLES_EN, ERROR_TITLES_EN_STANDARD, ERROR_TITLES_RU_STANDARD
from .problem import PROBLEM_CONTENT_TYPE, problem_body


def flatten_error_detail(data: Any, prefix: str = "") -> list[str]:
    """DRF `response.data` (вложенные dict/list из ErrorDetail) → плоский список
    человекочитаемых строк. До этого в `detail` уезжал `str(response.data)` —
    Python-repr вида `{'non_field_errors': [ErrorDetail(string=..., code=...)]}`,
    и пользователь видел его в UI (отсмотр 2026-08-23, /contracts/new/parties).

    `non_field_errors` и `detail` — без префикса поля; вложенные сериализаторы —
    через точку (`stages.0.amount: …`)."""
    if isinstance(data, dict):
        lines: list[str] = []
        for key, value in data.items():
            key_str = str(key)
            if key_str in ("non_field_errors", "detail"):
                child_prefix = prefix
            else:
                child_prefix = f"{prefix}.{key_str}" if prefix else key_str
            lines.extend(flatten_error_detail(value, child_prefix))
        return lines
    if isinstance(data, list):
        lines = []
        for index, item in enumerate(data):
            # Индекс — только для вложенных структур (список объектов);
            # несколько сообщений одного поля индексов не получают.
            child_prefix = f"{prefix}.{index}" if isinstance(item, (dict, list)) else prefix
            lines.extend(flatten_error_detail(item, child_prefix))
        return lines
    message = str(data)
    return [f"{prefix}: {message}" if prefix else message]


_STATUS_TO_CODE = {
    400: "invalid_request",
    401: "authentication_required",
    403: "permission_denied",
    404: "not_found",
    405: "method_not_allowed",
    406: "not_acceptable",
    409: "conflict",
    415: "unsupported_media_type",
    422: "unprocessable_entity",
    429: "rate_limited",
}


class ProblemJSONRenderer(JSONRenderer):
    media_type = PROBLEM_CONTENT_TYPE


class DomainAPIError(APIException):
    """Базовый класс для доменных ошибок api/-слоя. Поднимается во view в
    ответ на исключение services.py — сама по себе никогда не поднимается
    из services.py (там нет DRF)."""

    def __init__(
        self,
        *,
        status_code: int,
        code: str,
        title: str,
        detail: str = "",
        context: dict[str, Any] | None = None,
        retry_after: int | None = None,
    ) -> None:
        self.status_code = status_code
        self.code = code
        self.title = title
        self.context = context or {}
        # `Retry-After` (секунды) для 429 — тот же приём, что `wait` у DRF
        # Throttled, которого доменная ошибка не наследует. Без заголовка
        # клиенту неоткуда узнать, когда повторять: `detail` — текст для
        # человека, а не машиночитаемая пауза (ADR-168; до этого заголовок
        # ставила руками только archive_link_view — единственная не-DRF вьюха).
        self.retry_after = retry_after
        super().__init__(detail=detail or title)


def _force_problem_json_renderer(context: dict[str, Any]) -> None:
    """finalize_response() (DRF, вызывается ПОСЛЕ exception handler) берёт
    accepted_renderer/accepted_media_type с request, а не с response, если
    на request они ещё не установлены — иначе сам сделает негоциацию и
    перезапишет наш Content-Type обратно на application/json. Поэтому
    подменяем именно на request."""
    request = context.get("request")
    if request is None:
        return
    renderer = ProblemJSONRenderer()
    request.accepted_renderer = renderer
    request.accepted_media_type = renderer.media_type


def problem_json_exception_handler(exc: Exception, context: dict[str, Any]) -> Response | None:
    if isinstance(exc, DomainAPIError):
        _force_problem_json_renderer(context)
        title = exc.title
        request = context.get("request")
        if request is not None:
            locale = resolve_request_locale(request)
            if locale != "ru":
                title = get_error_title(exc.code, locale=locale) or ERROR_TITLES_EN.get(
                    exc.code, exc.title
                )
        headers = (
            {"Retry-After": str(int(exc.retry_after))} if exc.retry_after is not None else None
        )
        return Response(
            problem_body(
                status=exc.status_code,
                code=exc.code,
                title=title,
                detail=str(exc.detail) if exc.detail else "",
                context=exc.context,
            ),
            status=exc.status_code,
            headers=headers,
        )

    response = exception_handler(exc, context)
    if response is None:
        return None

    _force_problem_json_renderer(context)
    code = _STATUS_TO_CODE.get(response.status_code, "error")
    title = _standard_title(code, context.get("request"))
    lines = flatten_error_detail(response.data) if response.data else []
    # Структура ошибок по полям — в context.errors: фронт может подсветить поля,
    # не разбирая склеенный detail (ErrorDetail — подкласс str, JSON-безопасен).
    errors_context = {"errors": response.data} if isinstance(response.data, (dict, list)) else None
    response.data = problem_body(
        status=response.status_code,
        code=code,
        title=title,
        detail="; ".join(lines),
        context=errors_context,
    )
    return response


def _standard_title(code: str, request: Any) -> str:
    """Заголовок стандартной DRF-ошибки на языке запроса (ADR-119): пакет
    языка (apps.l10n, свой фолбэк locale→en) → встроенные RU/EN реестры →
    сам код (как раньше). До этого title == code для всех языков, включая RU."""
    locale = resolve_request_locale(request) if request is not None else "ru"
    if locale == "ru":
        # RU — канонический контур, пакеты его не обслуживают (l10n/README.md);
        # без похода в БД — как и ветка DomainAPIError выше.
        return ERROR_TITLES_RU_STANDARD.get(code, code)
    from_pack = get_error_title(code, locale=locale)
    if from_pack:
        return from_pack
    return ERROR_TITLES_EN_STANDARD.get(code, code)
