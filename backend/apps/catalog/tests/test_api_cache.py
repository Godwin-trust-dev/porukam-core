"""№8 отсмотра 2026-08-18 — кэш готовых ответов справочников каталога
(apps.catalog.api.views._cached_payload): включается CATALOG_CACHE_TTL,
по умолчанию выключен (dev/тесты правят каталог и ждут свежие чтения)."""

from __future__ import annotations

import pytest
from django.core.cache import cache
from django.test import override_settings
from rest_framework.test import APIClient

from apps.catalog.models import Sphere

pytestmark = pytest.mark.django_db


@pytest.fixture(autouse=True)
def _clean_cache():
    cache.clear()
    yield
    cache.clear()


def _codes(resp) -> list[str]:
    return [s["code"] for s in resp.data["results"]]


@override_settings(CATALOG_CACHE_TTL=600)
def test_spheres_cached_within_ttl_and_key_includes_locale():
    client = APIClient()
    first = client.get("/v1/spheres")
    assert first.status_code == 200

    Sphere.objects.create(code="cache_probe", name_i18n={"ru": "Проба"}, is_active=True)

    # Тот же locale — кэшированный ответ, новой сферы ещё не видно.
    second = client.get("/v1/spheres")
    assert _codes(second) == _codes(first)
    assert "cache_probe" not in _codes(second)

    # Другой locale — другой ключ, собирается заново и видит свежие данные.
    other_locale = client.get("/v1/spheres", HTTP_ACCEPT_LANGUAGE="en")
    assert "cache_probe" in _codes(other_locale)


@override_settings(CATALOG_CACHE_TTL=600)
def test_sphere_search_is_never_cached():
    """Поисковые выдачи (q=) не кэшируются: пространство ключей — произвольные
    строки, hit-rate ~0 — build выполняется всегда и видит свежие данные."""
    client = APIClient()
    assert client.get("/v1/spheres", {"q": "Проба"}).status_code == 200

    Sphere.objects.create(code="cache_probe", name_i18n={"ru": "Проба"}, is_active=True)

    found = client.get("/v1/spheres", {"q": "Проба"})
    assert "cache_probe" in _codes(found)


def test_cache_disabled_by_default_sees_fresh_data():
    """Дефолт CATALOG_CACHE_TTL=0: каждое чтение — свежее (тестовые и dev
    сценарии правят каталог между запросами)."""
    client = APIClient()
    first = client.get("/v1/spheres")
    assert "cache_probe" not in _codes(first)

    Sphere.objects.create(code="cache_probe", name_i18n={"ru": "Проба"}, is_active=True)

    second = client.get("/v1/spheres")
    assert "cache_probe" in _codes(second)
