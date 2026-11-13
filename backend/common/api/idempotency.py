"""Idempotency-Key на денежных/подписных POST (CLAUDE.md, etap-4.md Э4.4).

Использование во view (см. apps/contracts/api/views.py ContractSignView):

    key = require_idempotency_key(request)
    cached = lookup(user=request.user, endpoint="contracts.sign", key=key, body=request.data)
    if cached is not None:
        return Response(cached.response_body, status=cached.response_status)
    ...
    response = Response(...)
    store(user=request.user, endpoint="contracts.sign", key=key, body=request.data,
          status_code=response.status_code, response_body=response.data)
    return response

Тот же `Idempotency-Key` с ДРУГИМ телом запроса — `IdempotencyKeyReusedError`
(ключ адресует конкретный запрос, не конкретный вызов метода вообще)."""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any

from django.db import IntegrityError, transaction
from rest_framework.renderers import JSONRenderer
from rest_framework.request import Request

from apps.accounts.models import User
from common.canonical import canonical_json_bytes, sha256_hex
from common.models import IdempotencyKey

HEADER_NAME = "Idempotency-Key"


class IdempotencyKeyRequiredError(ValueError):
    """Заголовок `Idempotency-Key` обязателен на этом эндпоинте, но не
    передан."""


class IdempotencyKeyReusedError(ValueError):
    """Тот же ключ уже использован этим пользователем на этом эндпоинте с
    ДРУГИМ телом запроса — ключ адресует конкретный запрос, повторно на
    другой запрос не переиспользуется."""


@dataclass(frozen=True, slots=True)
class CachedResponse:
    status_code: int
    body: Any


def _request_hash(body: Any) -> str:
    return sha256_hex(canonical_json_bytes(dict(body)))


def _json_safe(data: Any) -> Any:  # noqa: ANN401
    """`build_body(...)` во view — обычно `SomeSerializer(instance).data`
    (`OrderedDict` с «сырыми» Python-типами: UUID/Decimal/datetime — сериалайзер
    приводит их к JSON-виду только на этапе рендеринга HTTP-ответа, не в
    `.data`). `models.JSONField` без `encoder=DjangoJSONEncoder` их не
    сериализует — прогоняем через DRF `JSONRenderer` (тот же кодировщик, что
    увидел бы клиент) перед записью в БД."""
    return json.loads(JSONRenderer().render(data))


def require_idempotency_key(request: Request) -> str:
    key = request.headers.get(HEADER_NAME)
    if not key:
        raise IdempotencyKeyRequiredError(f"заголовок {HEADER_NAME} обязателен")
    return key


def lookup(*, user: User, endpoint: str, key: str, body: Any) -> CachedResponse | None:
    try:
        record = IdempotencyKey.objects.get(user=user, endpoint=endpoint, key=key)
    except IdempotencyKey.DoesNotExist:
        return None
    if record.request_hash != _request_hash(body):
        raise IdempotencyKeyReusedError(
            f"ключ {key!r} уже использован на {endpoint!r} с другим телом запроса"
        )
    return CachedResponse(status_code=record.response_status, body=record.response_body)


def store(
    *, user: User, endpoint: str, key: str, body: Any, status_code: int, response_body: Any
) -> None:
    """Гонка двух одновременных запросов с тем же ключом — не наша забота:
    UNIQUE-констрейнт (миграция) ловит вторую запись, IntegrityError молча
    проглатывается — второй вызов просто не сохранил свой ответ, что
    безопасно (side-effect уже применён один раз сервисным слоем до этого
    вызова; см. вызывающий view — dead-письмо здесь не критично, ключ создан
    для клиентских ретраев одного клиента, не для защиты от гонки)."""
    try:
        with transaction.atomic():
            IdempotencyKey.objects.create(
                user=user,
                endpoint=endpoint,
                key=key,
                request_hash=_request_hash(body),
                response_status=status_code,
                response_body=_json_safe(response_body),
            )
    except IntegrityError:
        pass
