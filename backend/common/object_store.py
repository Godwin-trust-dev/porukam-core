"""Generic S3-совместимое объектное хранилище (ADR-117 §8): общий
Protocol+S3+Fake, вынесенный из apps/profiles/storage.py (ADR-103), чтобы
логотипы объединений (apps.social) могли переиспользовать пайплайн без
импорта apps.profiles (import-linter: «social зависит только от accounts»).

boto3 — ленивый импорт внутри метода: ядро его не знает (тот же приём, что
apps/evidence/storage.py). Объекты УДАЛЯЮТСЯ физически (замена/удаление
фото — ПД, мягкого удаления нет), поэтому в Protocol есть `delete`.

Каждый потребитель держит СВОЙ fake-синглтон и свой тумблер настроек
(build_avatar_store / build_logo_store): общий инстанс смешал бы
пространства ключей в тестах."""

from __future__ import annotations

from typing import Any, Protocol

from django.conf import settings


def build_s3_client() -> Any:  # noqa: ANN401
    """Один boto3-клиент на все S3-хранилища проекта (аватары, оригиналы
    доказательств, чекпойнты Vault) — те же `settings.AWS_*`; boto3
    импортируется лениво (см. докстринг модуля)."""
    import boto3  # ленивый импорт — см. докстринг модуля
    from botocore.config import Config

    # Таймауты и ретраи — ЯВНО (docs/performance-capacity.md §7.4): дефолт
    # botocore — 60 с connect + 60 с read + до 5 попыток, т.е. один запрос к
    # недоступному R2 держал поток core до ~5 минут. health.py тот же клиент
    # строит с 1 с/0 попыток — тут боевой путь (загрузка до 25 МБ, чекпойнт,
    # архив), поэтому запас больше, но конечный.
    return boto3.client(
        "s3",
        endpoint_url=settings.AWS_S3_ENDPOINT_URL,
        aws_access_key_id=settings.AWS_ACCESS_KEY_ID,
        aws_secret_access_key=settings.AWS_SECRET_ACCESS_KEY,
        config=Config(
            connect_timeout=settings.S3_CONNECT_TIMEOUT_SECONDS,
            read_timeout=settings.S3_READ_TIMEOUT_SECONDS,
            retries={"max_attempts": settings.S3_MAX_ATTEMPTS, "mode": "standard"},
        ),
    )


class ObjectStore(Protocol):
    def put(self, key: str, body: bytes, *, content_type: str) -> None: ...

    def get(self, key: str) -> bytes | None: ...

    def delete(self, key: str) -> None: ...


class S3ObjectStore:
    def __init__(self, *, bucket: str) -> None:
        self._bucket = bucket

    def _client(self) -> Any:
        return build_s3_client()

    def put(self, key: str, body: bytes, *, content_type: str) -> None:
        self._client().put_object(Bucket=self._bucket, Key=key, Body=body, ContentType=content_type)

    def get(self, key: str) -> bytes | None:
        from botocore.exceptions import ClientError  # ленивый импорт

        try:
            response = self._client().get_object(Bucket=self._bucket, Key=key)
        except ClientError as exc:
            if exc.response.get("Error", {}).get("Code") in {"NoSuchKey", "404"}:
                return None
            raise
        return response["Body"].read()  # type: ignore[no-any-return]

    def delete(self, key: str) -> None:
        self._client().delete_object(Bucket=self._bucket, Key=key)


class FakeObjectStore:
    """Детерминированный фейк для тестов/локалки — объекты в памяти."""

    def __init__(self) -> None:
        self.objects: dict[str, bytes] = {}

    def put(self, key: str, body: bytes, *, content_type: str) -> None:
        self.objects[key] = body

    def get(self, key: str) -> bytes | None:
        return self.objects.get(key)

    def delete(self, key: str) -> None:
        self.objects.pop(key, None)
