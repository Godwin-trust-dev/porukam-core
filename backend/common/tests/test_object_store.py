"""Общий S3-клиент (common/object_store.py) обязан строиться с ЯВНЫМИ
таймаутами и лимитом попыток (docs/performance-capacity.md §7.4): дефолт
botocore — 60 с connect + 60 с read + до 5 попыток, т.е. один запрос к
недоступному хранилищу держал поток core минуты. Плюс пределы задач Celery
(§7.2) — через namespace CELERY_* в settings."""

from __future__ import annotations

from typing import Any

import pytest
from django.test import override_settings

from common import object_store


class _FakeBoto3:
    def __init__(self) -> None:
        self.kwargs: dict[str, Any] = {}

    def client(self, service: str, **kwargs: Any) -> str:  # noqa: ANN401
        self.kwargs = {"service": service, **kwargs}
        return "client"


@pytest.fixture
def fake_boto3(monkeypatch: pytest.MonkeyPatch) -> _FakeBoto3:
    fake = _FakeBoto3()
    monkeypatch.setitem(__import__("sys").modules, "boto3", fake)
    return fake


@override_settings(
    AWS_S3_ENDPOINT_URL="https://s3.example.com",
    AWS_ACCESS_KEY_ID="key",
    AWS_SECRET_ACCESS_KEY="secret",
    S3_CONNECT_TIMEOUT_SECONDS=5.0,
    S3_READ_TIMEOUT_SECONDS=30.0,
    S3_MAX_ATTEMPTS=3,
)
def test_build_s3_client_passes_explicit_timeouts_and_retries(fake_boto3: _FakeBoto3) -> None:
    assert object_store.build_s3_client() == "client"
    assert fake_boto3.kwargs["service"] == "s3"
    assert fake_boto3.kwargs["endpoint_url"] == "https://s3.example.com"
    config = fake_boto3.kwargs["config"]
    assert config.connect_timeout == 5.0
    assert config.read_timeout == 30.0
    assert config.retries == {"max_attempts": 3, "mode": "standard"}


@override_settings(
    AWS_S3_ENDPOINT_URL=None,
    AWS_ACCESS_KEY_ID=None,
    AWS_SECRET_ACCESS_KEY=None,
    S3_CONNECT_TIMEOUT_SECONDS=1.5,
    S3_READ_TIMEOUT_SECONDS=2.5,
    S3_MAX_ATTEMPTS=1,
)
def test_build_s3_client_timeouts_are_settings_not_constants(fake_boto3: _FakeBoto3) -> None:
    object_store.build_s3_client()
    config = fake_boto3.kwargs["config"]
    assert (config.connect_timeout, config.read_timeout) == (1.5, 2.5)
    assert config.retries["max_attempts"] == 1


def test_celery_task_limits_are_configured() -> None:
    """Без time_limit зависший внешний вызов держит процесс воркера вечно;
    prefetch 1 — длинная сборка архива не резервирует пачку коротких задач."""
    from config.celery import app

    assert app.conf.task_soft_time_limit == 540
    assert app.conf.task_time_limit == 600
    assert app.conf.task_soft_time_limit < app.conf.task_time_limit
    assert app.conf.worker_prefetch_multiplier == 1
    assert app.conf.worker_max_tasks_per_child == 200
