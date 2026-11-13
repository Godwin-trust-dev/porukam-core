"""`TimestampProvider` — метка доверенного времени для юридически значимых
меток (etap-4.md, общие требования Э4: "Метки времени — через
`TimestampProvider` (серверная метка Р1) с полем «источник метки»";
tech-spec.md финмодель v2-баннер: "TSA в Р1 — серверные метки через интерфейс
`TimestampProvider` ... RFC 3161 подключается после запуска подписки — Ю-21").

Р1 — только `ServerTimestampProvider` (`source="server"`): метка сервера,
`TimestampProvider` — задел под будущую RFC 3161-реализацию
(`source="rfc3161"`), которая заменит инъекцию без изменения вызывающего
кода (тот же приём инъекции провайдера, что apps.notifications.services
default-провайдеры / apps.entities.providers)."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Protocol

from django.utils import timezone


@dataclass(frozen=True, slots=True)
class TrustedTimestamp:
    at: datetime
    source: str


class TimestampProvider(Protocol):
    def now(self) -> TrustedTimestamp: ...


class ServerTimestampProvider:
    """Р1: серверная метка (`timezone.now()`), источник — `"server"`."""

    def now(self) -> TrustedTimestamp:
        return TrustedTimestamp(at=timezone.now(), source="server")


DEFAULT_TIMESTAMP_PROVIDER = ServerTimestampProvider()
