"""Доступ к внутренним метрикам — docs/tasks/marketing-metrics.md §9.1:
статический токен из переменной окружения плюс ограничение по адресам.
Наружу эндпоинты не выведены — тот же принцип, что у эндпоинта метрик
Prometheus, который тоже не выведен за периметр.

Почему не JWT и не сессия: у метрик нет пользователя. Это машинный доступ
из среды разработки и из ночного скрипта; заводить под него учётную запись
означало бы завести субъект, которого в аналитике не должно быть вовсе.
"""

from __future__ import annotations

import ipaddress
import secrets
from typing import Any

from django.conf import settings
from django.http import HttpRequest
from rest_framework.permissions import BasePermission

from common.net import client_ip

_ANY = "*"


def _token_matches(request: HttpRequest, expected: str) -> bool:
    header = str(request.META.get("HTTP_AUTHORIZATION", ""))
    scheme, _, value = header.partition(" ")
    if scheme.lower() != "bearer" or not value:
        return False
    # Сравнение постоянного времени: токен статический и живёт долго.
    return secrets.compare_digest(value.strip(), expected)


def _ip_allowed(address: str, allowed: list[str]) -> bool:
    if not allowed or _ANY in allowed:
        return True
    if not address:
        return False
    try:
        parsed = ipaddress.ip_address(address)
    except ValueError:
        return False
    for entry in allowed:
        try:
            if "/" in entry:
                if parsed in ipaddress.ip_network(entry, strict=False):
                    return True
            elif parsed == ipaddress.ip_address(entry):
                return True
        except ValueError:
            continue
    return False


class InternalMetricsPermission(BasePermission):
    """Пустой `ANALYTICS_METRICS_TOKEN` закрывает эндпоинты полностью.

    Это сознательный дефолт: контур, который «работает из коробки без
    настройки», в проде оказывается открытым. Лучше пустой ответ 403 на
    ненастроенном стенде, чем внутренние метрики наружу."""

    message = "внутренние метрики: нужен статический токен и разрешённый адрес"

    def has_permission(self, request: Any, view: Any) -> bool:
        expected = str(getattr(settings, "ANALYTICS_METRICS_TOKEN", "") or "")
        if not expected:
            return False
        allowed = list(getattr(settings, "ANALYTICS_ALLOWED_IPS", []) or [])
        return _token_matches(request, expected) and _ip_allowed(client_ip(request), allowed)
