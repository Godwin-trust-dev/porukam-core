"""Импорт стартового фото из Google (ADR-103 п.2) — фоновая задача, чтобы
вход не ждал внешний HTTP и не падал от недоступности Google CDN. НЕ
доменный дедлайн (sweep не нужен): потерянная задача = профиль без фото,
пользователь загрузит сам. Без ретраев намеренно."""

from __future__ import annotations

from celery import shared_task

from . import services
from .models import Profile


@shared_task  # type: ignore[untyped-decorator]  # celery.* без типов (ignore_missing_imports)
def fetch_external_avatar(profile_id: str, url: str) -> bool:
    profile = Profile.objects.filter(pk=profile_id).first()
    if profile is None:
        return False
    return services.import_external_avatar(profile, url)
