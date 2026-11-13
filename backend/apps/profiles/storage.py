"""Хранилище фото профиля (ADR-103) — S3-совместимый бакет
`PROFILE_AVATAR_BUCKET_NAME`. Классы Protocol+S3+Fake вынесены в
common/object_store.py (ADR-117 §8 — пайплайн переиспользуют логотипы
объединений); здесь остаётся только профильная обвязка: имена-алиасы,
тумблер настроек и fake-синглтон.

Тумблер `settings.PROFILE_AVATAR_STORE` (`fake`|`s3`) читается на каждый
вызов `build_avatar_store()` (как `build_google_login_provider`), чтобы
`override_settings` в тестах работал предсказуемо. Fake — ОДИН экземпляр на
процесс: Celery-задача импорта из Google и view отдачи должны видеть одни и
те же объекты в тестах (CELERY_TASK_ALWAYS_EAGER)."""

from __future__ import annotations

from django.conf import settings

from common.object_store import FakeObjectStore, ObjectStore, S3ObjectStore

AvatarObjectStore = ObjectStore
FakeAvatarObjectStore = FakeObjectStore


class S3AvatarObjectStore(S3ObjectStore):
    def __init__(self, *, bucket: str | None = None) -> None:
        super().__init__(bucket=bucket or settings.PROFILE_AVATAR_BUCKET_NAME)


_fake_store = FakeObjectStore()


def build_avatar_store() -> AvatarObjectStore:
    if settings.PROFILE_AVATAR_STORE == "s3":
        return S3AvatarObjectStore()
    return _fake_store


def reset_fake_store() -> None:
    """Для тестов — чистый бакет между кейсами (conftest)."""
    _fake_store.objects.clear()
