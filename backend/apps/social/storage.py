"""Хранилище медиа объединений — логотипы (ADR-117 §8) и фото портфолио
(ADR-128): общий пайплайн common/object_store.py, свой fake-синглтон и свой
тумблер.

Настройки НАМЕРЕННО падают обратно на профильные (`GROUP_LOGO_STORE` →
`PROFILE_AVATAR_STORE`, `GROUP_LOGO_BUCKET_NAME` → `PROFILE_AVATAR_BUCKET_NAME`):
прод уже настроен на s3/общий бакет для аватаров (инцидент 2026-08-24
«фото профиля не сохраняется» — из-за невыставленного тумблера), логотипы
не должны наступить на те же грабли из-за забытой новой переменной.
Пространство ключей своё: `group-logos/<group_id>/…` и
`group-portfolio/<group_id>/…` — пересечений с `avatars/…`/`portfolio/…` нет."""

from __future__ import annotations

from django.conf import settings

from common.object_store import FakeObjectStore, ObjectStore, S3ObjectStore

_fake_store = FakeObjectStore()


def _store_mode() -> str:
    return str(getattr(settings, "GROUP_LOGO_STORE", None) or settings.PROFILE_AVATAR_STORE)


def _bucket() -> str:
    return str(
        getattr(settings, "GROUP_LOGO_BUCKET_NAME", None) or settings.PROFILE_AVATAR_BUCKET_NAME
    )


def build_logo_store() -> ObjectStore:
    if _store_mode() == "s3":
        return S3ObjectStore(bucket=_bucket())
    return _fake_store


def reset_fake_store() -> None:
    """Для тестов — чистый бакет между кейсами."""
    _fake_store.objects.clear()


def build_group_media_store() -> ObjectStore:
    """Фото портфолио объединения (ADR-128) — тот же бакет и тот же
    fake-синглтон, что логотипы: разводятся ПРЕФИКСОМ ключа
    (`group-logos/…` против `group-portfolio/…`). Отдельного тумблера
    намеренно нет — одна забытая переменная окружения меньше (та же
    мотивация, что в docstring модуля)."""
    return build_logo_store()
