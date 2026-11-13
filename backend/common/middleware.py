"""Сквозной request_id (docs/tasks/fundament-2.md ЭФ.6 п.1): читает
`X-Request-Id` от клиента/реверс-прокси или генерирует новый, кладёт в
structlog-контекст (contextvars) на время запроса — попадает в КАЖДУЮ
запись лога, сделанную при обработке (structlog.get_logger() и обычный
logging.getLogger(__name__) — common/logging.py оборачивает оба).

Ставится ПОСЛЕ apps.accounts.middleware.ActingProfileMiddleware (см.
MIDDLEWARE, config/settings/base.py), чтобы actor (acting_profile_id) был
уже разобран и попал в контекст логов тем же запросом — без PII (UUID, не
телефон/ФИО)."""

from __future__ import annotations

import uuid
from collections.abc import Callable

import structlog
from django.http import HttpRequest, HttpResponse

from .logging import REQUEST_ID_HEADER

_META_KEY = "HTTP_X_REQUEST_ID"


class RequestContextMiddleware:
    def __init__(self, get_response: Callable[[HttpRequest], HttpResponse]) -> None:
        self.get_response = get_response

    def __call__(self, request: HttpRequest) -> HttpResponse:
        request_id = request.META.get(_META_KEY) or str(uuid.uuid4())
        request.request_id = request_id  # type: ignore[attr-defined]

        context: dict[str, object] = {
            "request_id": request_id,
            "method": request.method,
            "path": request.path,
        }
        acting_profile_id = getattr(request, "acting_profile_id", None)
        if acting_profile_id is not None:
            context["acting_profile_id"] = str(acting_profile_id)

        structlog.contextvars.clear_contextvars()
        structlog.contextvars.bind_contextvars(**context)
        try:
            response = self.get_response(request)
        finally:
            structlog.contextvars.clear_contextvars()

        response[REQUEST_ID_HEADER] = request_id
        return response
