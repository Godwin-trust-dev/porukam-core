"""docs/tasks/fundament-2.md ЭФ.6 п.5: расширенный /v1/health — БД,
redis×2, S3, Audit Vault, с деградацией (сбой некритичного компонента не
валит остальные проверки и не всегда превращает ответ в 5xx)."""

from __future__ import annotations

import json
from unittest.mock import patch

import pytest
from django.conf import settings
from django.test import RequestFactory, override_settings

from config.health import _check_s3, health

pytestmark = pytest.mark.django_db(databases=["default", "audit"])


def _call():
    response = health(RequestFactory().get("/v1/health"))
    return response.status_code, json.loads(response.content)


def test_all_healthy_reports_ok_200():
    with patch("config.health._check_s3", return_value="ok"):
        status_code, body = _call()

    assert status_code == 200
    assert body["status"] == "ok"
    assert body["components"]["database"] == "ok"
    assert body["components"]["audit_vault"] == "ok"


def test_database_down_reports_down_503():
    with (
        patch("config.health._check_database", side_effect=lambda alias: "down"),
        patch("config.health._check_redis", return_value="ok"),
        patch("config.health._check_s3", return_value="ok"),
    ):
        status_code, body = _call()

    assert status_code == 503
    assert body["status"] == "down"


def test_redis_cache_down_degrades_without_failing_other_checks():
    cache_url = settings.CACHES["default"]["LOCATION"]

    def fake_redis(url):
        return "down" if url == cache_url else "ok"

    with (
        patch("config.health._check_redis", side_effect=fake_redis),
        patch("config.health._check_s3", return_value="ok"),
    ):
        status_code, body = _call()

    assert status_code == 200
    assert body["status"] == "degraded"
    assert body["components"]["redis_cache"] == "down"
    assert body["components"]["database"] == "ok"


def test_s3_unreachable_degrades_but_stays_200():
    with patch("config.health._check_s3", return_value="down"):
        status_code, body = _call()

    assert status_code == 200
    assert body["status"] == "degraded"
    assert body["components"]["s3"] == "down"


def test_audit_vault_db_down_degrades_but_stays_200():
    def fake_database(alias):
        return "down" if alias == "audit" else "ok"

    with (
        patch("config.health._check_database", side_effect=fake_database),
        patch("config.health._check_s3", return_value="ok"),
    ):
        status_code, body = _call()

    assert status_code == 200
    assert body["status"] == "degraded"
    assert body["components"]["audit_vault"] == "down"


@override_settings(AWS_S3_ENDPOINT_URL=None)
def test_s3_not_configured_is_treated_as_ok():
    status_code, body = _call()

    assert status_code == 200
    assert body["components"]["s3"] == "ok"


# docs/tasks/Задача_fix_health-s3-scoped-probe.md — зонд обязан проверять
# бакет через list_objects_v2 (bucket-scoped), НЕ list_buckets() (аккаунт-
# уровневая операция, которую scoped R2-токен "Object Read & Write" не
# разрешает — AccessDenied на реально рабочем хранилище).
@override_settings(
    AWS_S3_ENDPOINT_URL="https://s3.example.com",
    AWS_ACCESS_KEY_ID="test-key",
    AWS_SECRET_ACCESS_KEY="test-secret",
    AWS_STORAGE_BUCKET_NAME="porukam-prod",
)
def test_check_s3_probes_configured_bucket_not_list_buckets():
    with patch("boto3.client") as make_client:
        client = make_client.return_value
        client.list_buckets.side_effect = AssertionError(
            "list_buckets() — аккаунт-уровневая операция, scoped-токен её не разрешает"
        )

        assert _check_s3() == "ok"

    client.list_objects_v2.assert_called_once_with(Bucket="porukam-prod", MaxKeys=1)
    client.list_buckets.assert_not_called()


@override_settings(
    AWS_S3_ENDPOINT_URL="https://s3.example.com",
    AWS_ACCESS_KEY_ID="test-key",
    AWS_SECRET_ACCESS_KEY="test-secret",
    AWS_STORAGE_BUCKET_NAME="porukam-prod",
)
def test_check_s3_reports_down_when_bucket_probe_fails():
    with patch("boto3.client") as make_client:
        client = make_client.return_value
        client.list_objects_v2.side_effect = Exception("AccessDenied")

        assert _check_s3() == "down"
