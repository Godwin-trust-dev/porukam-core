"""Healthcheck: GET /v1/health (docs/tasks/fundament-2.md ЭФ.6 п.5) —
проверяет БД, redis×2 (кеш и брокер — разделены, dev-setup.md §2), S3 и
Audit Vault (отдельная БД, ADR-038), КАЖДЫЙ независимо, БЕЗ каскадного
падения: сбой одного компонента не мешает проверить остальные и не всегда
превращает ответ в 5xx — только отказ БД (без неё core не функционирует
вообще) переводит статус в "down" (503); отказ любого другого компонента —
"degraded" (200, сервис всё ещё частично работоспособен)."""

from __future__ import annotations

import logging

from django.conf import settings
from django.db import connections
from django.http import HttpRequest, JsonResponse

logger = logging.getLogger(__name__)

_OK = "ok"
_DOWN = "down"

# Отказ этих компонентов — единственный, что переводит общий статус в
# "down"/503: без БД core не может обслуживать ни один запрос вообще.
_CRITICAL_COMPONENTS = frozenset({"database"})


def _check_database(alias: str) -> str:
    try:
        with connections[alias].cursor() as cursor:
            cursor.execute("SELECT 1")
        return _OK
    except Exception:
        logger.warning("health: БД %s недоступна", alias, exc_info=True)
        return _DOWN


def _check_redis(url: str) -> str:
    try:
        import redis

        redis.Redis.from_url(url, socket_connect_timeout=1, socket_timeout=1).ping()
        return _OK
    except Exception:
        logger.warning("health: redis (%s) недоступен", url, exc_info=True)
        return _DOWN


def _check_s3() -> str:
    endpoint = settings.AWS_S3_ENDPOINT_URL
    if not endpoint:
        # Не настроен (напр. тестовый профиль) — не считается деградацией
        # окружения, в котором S3 сознательно не используется.
        return _OK
    try:
        import boto3
        from botocore.config import Config

        client = boto3.client(
            "s3",
            endpoint_url=endpoint,
            aws_access_key_id=settings.AWS_ACCESS_KEY_ID,
            aws_secret_access_key=settings.AWS_SECRET_ACCESS_KEY,
            config=Config(connect_timeout=1, read_timeout=1, retries={"max_attempts": 0}),
        )
        # list_buckets() — операция уровня АККАУНТА (перечислить все бакеты),
        # scoped R2-токен ("Object Read & Write", least-privilege на конкретный
        # бакет) её не даёт → AccessDenied, зонд ложно "down" при реально
        # рабочем хранилище (docs/tasks/Задача_fix_health-s3-scoped-probe.md).
        # list_objects_v2(MaxKeys=1) требует только list-permission на САМ
        # бакет — единственная операция, которую и least-privilege object-
        # токен разрешает, и обычный аккаунт-токен тоже (не более узкая
        # проверка, чем раньше, для остальных провайдеров).
        client.list_objects_v2(Bucket=settings.AWS_STORAGE_BUCKET_NAME, MaxKeys=1)
        return _OK
    except Exception:
        logger.warning("health: S3 недоступен", exc_info=True)
        return _DOWN


def health(request: HttpRequest) -> JsonResponse:
    components = {
        "database": _check_database("default"),
        "redis_cache": _check_redis(settings.CACHES["default"]["LOCATION"]),
        "redis_broker": _check_redis(settings.CELERY_BROKER_URL),
        "s3": _check_s3(),
        "audit_vault": _check_database("audit"),
    }
    down = {name for name, status in components.items() if status != _OK}

    if not down:
        overall = "ok"
    elif down & _CRITICAL_COMPONENTS:
        overall = "down"
    else:
        overall = "degraded"

    return JsonResponse(
        {"status": overall, "components": components},
        status=200 if overall != "down" else 503,
    )
