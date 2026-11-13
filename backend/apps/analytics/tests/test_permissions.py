"""Доступ к внутренним метрикам (§9.1): статический токен + список адресов.

Проверяется главное свойство контура — он закрыт по умолчанию. Метрики
наружу не выведены, и «работает из коробки без настройки» здесь означало бы
«в проде открыто».
"""

from __future__ import annotations

import pytest
from django.test import override_settings
from rest_framework.test import APIClient

pytestmark = pytest.mark.django_db(databases=["default", "audit"])

ENDPOINTS = [
    "/internal/v1/metrics/pulse",
    "/internal/v1/metrics/geography",
    "/internal/v1/metrics/acquisition",
    "/internal/v1/metrics/funnel",
    "/internal/v1/metrics/languages",
    "/internal/v1/metrics/cohorts",
    "/internal/v1/metrics/health",
]
TOKEN = "s3cr3t-metrics-token"


@pytest.mark.parametrize("url", ENDPOINTS)
@override_settings(ANALYTICS_METRICS_TOKEN="", ANALYTICS_ALLOWED_IPS=["*"])
def test_endpoint_closed_without_configured_token(url: str) -> None:
    """✅ Пустой ANALYTICS_METRICS_TOKEN закрывает эндпоинт полностью."""
    assert APIClient().get(url).status_code == 403


@pytest.mark.parametrize("url", ENDPOINTS)
@override_settings(ANALYTICS_METRICS_TOKEN=TOKEN, ANALYTICS_ALLOWED_IPS=["*"])
def test_endpoint_requires_token(url: str) -> None:
    """🚫 Без заголовка Authorization — 403, даже с разрешённого адреса."""
    assert APIClient().get(url).status_code == 403


@pytest.mark.parametrize("url", ENDPOINTS)
@override_settings(ANALYTICS_METRICS_TOKEN=TOKEN, ANALYTICS_ALLOWED_IPS=["*"])
def test_endpoint_rejects_wrong_token(url: str) -> None:
    """🚫 Чужой токен не подходит."""
    client = APIClient()
    client.credentials(HTTP_AUTHORIZATION="Bearer wrong")
    assert client.get(url).status_code == 403


@pytest.mark.parametrize("url", ENDPOINTS)
@override_settings(ANALYTICS_METRICS_TOKEN=TOKEN, ANALYTICS_ALLOWED_IPS=["*"])
def test_endpoint_accepts_token(url: str) -> None:
    """✅ Верный токен — 200 и плоский JSON с именем метрики."""
    client = APIClient()
    client.credentials(HTTP_AUTHORIZATION=f"Bearer {TOKEN}")
    response = client.get(url)
    assert response.status_code == 200, response.content
    assert response.data["metric"] == url.rsplit("/", 1)[-1]
    assert response.data["source"] == "api"


@override_settings(ANALYTICS_METRICS_TOKEN=TOKEN, ANALYTICS_ALLOWED_IPS=["10.0.0.1"])
def test_endpoint_rejects_disallowed_address() -> None:
    """🚫 Верный токен с адреса вне списка не проходит."""
    client = APIClient()
    client.credentials(HTTP_AUTHORIZATION=f"Bearer {TOKEN}")
    assert client.get("/internal/v1/metrics/pulse").status_code == 403


@override_settings(ANALYTICS_METRICS_TOKEN=TOKEN, ANALYTICS_ALLOWED_IPS=["127.0.0.0/8"])
def test_endpoint_accepts_address_from_cidr() -> None:
    """✅ Подсеть в списке разрешает адрес из неё."""
    client = APIClient()
    client.credentials(HTTP_AUTHORIZATION=f"Bearer {TOKEN}")
    response = client.get("/internal/v1/metrics/pulse", REMOTE_ADDR="127.0.0.5")
    assert response.status_code == 200, response.content


@override_settings(ANALYTICS_METRICS_TOKEN=TOKEN, ANALYTICS_ALLOWED_IPS=["203.0.113.7"])
def test_endpoint_reads_real_ip_from_trusted_proxy() -> None:
    """✅ За нашим nginx (частный REMOTE_ADDR) адрес берётся из X-Real-IP."""
    client = APIClient()
    client.credentials(HTTP_AUTHORIZATION=f"Bearer {TOKEN}")
    response = client.get(
        "/internal/v1/metrics/pulse", REMOTE_ADDR="172.18.0.5", HTTP_X_REAL_IP="203.0.113.7"
    )
    assert response.status_code == 200, response.content


@override_settings(ANALYTICS_METRICS_TOKEN=TOKEN, ANALYTICS_ALLOWED_IPS=["203.0.113.7"])
def test_endpoint_ignores_spoofed_forwarded_for() -> None:
    """🚫 Подделанный клиентом X-Forwarded-For не обходит список адресов."""
    client = APIClient()
    client.credentials(HTTP_AUTHORIZATION=f"Bearer {TOKEN}")
    response = client.get(
        "/internal/v1/metrics/pulse",
        REMOTE_ADDR="172.18.0.5",
        HTTP_X_REAL_IP="198.51.100.9",
        HTTP_X_FORWARDED_FOR="203.0.113.7, 198.51.100.9",
    )
    assert response.status_code == 403


@override_settings(ANALYTICS_METRICS_TOKEN=TOKEN, ANALYTICS_ALLOWED_IPS=["203.0.113.7"])
def test_endpoint_ignores_real_ip_from_public_peer() -> None:
    """🚫 X-Real-IP от непроксирующего публичного адреса игнорируется."""
    client = APIClient()
    client.credentials(HTTP_AUTHORIZATION=f"Bearer {TOKEN}")
    response = client.get(
        "/internal/v1/metrics/pulse", REMOTE_ADDR="198.51.100.9", HTTP_X_REAL_IP="203.0.113.7"
    )
    assert response.status_code == 403


@override_settings(ANALYTICS_METRICS_TOKEN=TOKEN, ANALYTICS_ALLOWED_IPS=["203.0.113.7"])
def test_endpoint_ignores_malformed_real_ip() -> None:
    """🚫 Мусор в X-Real-IP -> берётся адрес соединения."""
    client = APIClient()
    client.credentials(HTTP_AUTHORIZATION=f"Bearer {TOKEN}")
    response = client.get(
        "/internal/v1/metrics/pulse", REMOTE_ADDR="172.18.0.5", HTTP_X_REAL_IP="not-an-ip"
    )
    assert response.status_code == 403
